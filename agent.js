#!/usr/bin/env node

/**
 * VPS隧道管理面板 - Agent客户端
 * 
 * 功能：
 * 1. 连接到WebSocket服务器
 * 2. 定期发送心跳和系统监控数据
 * 3. 接收并执行部署命令
 * 4. 上报部署结果
 */

const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// 读取配置文件
const CONFIG_PATH = process.env.CONFIG_PATH || '/opt/vps-agent/config.json';
let config;

try {
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  config = JSON.parse(configContent);
  console.log(`[Agent] 配置加载成功: Agent ID=${config.agentId}, Name=${config.name}`);
} catch (error) {
  console.error(`[Agent] 无法读取配置文件: ${CONFIG_PATH}`);
  console.error(error.message);
  process.exit(1);
}

// 验证必需的配置项
if (!config.agentId || !config.secret || !config.serverUrl) {
  console.error('[Agent] 配置文件缺少必需字段: agentId, secret, serverUrl');
  process.exit(1);
}

let ws = null;
let heartbeatInterval = null;
let reconnectTimeout = null;
let isConnected = false;

// 检查GOST服务状态
async function getGostStatus() {
  try {
    // 检查GOST服务是否运行
    const { stdout: isActive } = await execAsync('systemctl is-active gost 2>/dev/null || echo "inactive"');
    const active = isActive.trim() === 'active';
    
    if (!active) {
      return {
        running: false,
        lastSync: null,
        configHash: null,
        ruleCount: 0
      };
    }
    
    // 读取GOST配置文件获取规则数量和哈希
    let configHash = null;
    let ruleCount = 0;
    try {
      const configPath = '/etc/gost/config.json';
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configContent);
        
        // 计算配置哈希
        const crypto = require('crypto');
        configHash = crypto.createHash('sha256').update(configContent).digest('hex').substring(0, 16);
        
        // 统计规则数量（services数组长度）
        if (config.services && Array.isArray(config.services)) {
          ruleCount = config.services.length;
        }
      }
    } catch (err) {
      console.error('[Agent] 读取GOST配置失败:', err.message);
    }
    
    // 获取最后同步时间（从gost-polling-client服务日志）
    let lastSync = null;
    try {
      const { stdout: logOutput } = await execAsync(
        'journalctl -u gost-polling-client -n 20 --no-pager 2>/dev/null | grep "配置更新完成" | tail -1'
      );
      if (logOutput.trim()) {
        // 从日志中提取时间戳
        const match = logOutput.match(/(\w{3}\s+\d{2}\s+\d{2}:\d{2}:\d{2})/);
        if (match) {
          lastSync = match[1];
        }
      }
    } catch (err) {
      // 忽略日志读取错误
    }
    
    return {
      running: true,
      lastSync,
      configHash,
      ruleCount
    };
  } catch (error) {
    console.error('[Agent] 获取GOST状态失败:', error.message);
    return {
      running: false,
      lastSync: null,
      configHash: null,
      ruleCount: 0
    };
  }
}

// 获取本机IP地址
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  
  // 优先查找公网IP（通过接口名称判断）
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('lo')) continue; // 跳过回环接口
    
    const iface = interfaces[name];
    for (const addr of iface) {
      // 优先返回IPv4地址
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  
  // 如果没有找到IPv4，返回IPv6
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('lo')) continue;
    
    const iface = interfaces[name];
    for (const addr of iface) {
      if (addr.family === 'IPv6' && !addr.internal) {
        return addr.address;
      }
    }
  }
  
  return '未知';
}

// 获取系统监控数据
async function getSystemStats() {
  try {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // 计算CPU使用率（简化版本）
    let totalIdle = 0;
    let totalTick = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
    
    // 获取网络流量（从/proc/net/dev）
    let networkStats = { received: 0, sent: 0 };
    try {
      const netdev = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = netdev.split('\n');
      for (const line of lines) {
        if (line.includes(':')) {
          const parts = line.trim().split(/\s+/);
          if (parts[0] && !parts[0].startsWith('lo:')) {
            networkStats.received += parseInt(parts[1]) || 0;
            networkStats.sent += parseInt(parts[9]) || 0;
          }
        }
      }
    } catch (err) {
      console.error('[Agent] 无法读取网络统计:', err.message);
    }
    
    // 获取系统运行时间
    const uptime = os.uptime();
    
    // 获取GOST服务状态
    const gostStatus = await getGostStatus();
    
    return {
      cpu: cpuUsage,
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percentage: (usedMem / totalMem * 100).toFixed(1)
      },
      network: networkStats,
      uptime: Math.floor(uptime),
      gost: gostStatus
    };
  } catch (error) {
    console.error('[Agent] 获取系统统计失败:', error.message);
    return null;
  }
}

// 发送心跳
async function sendHeartbeat() {
  if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    const stats = await getSystemStats();
    if (!stats) {
      return;
    }
    
    const message = {
      type: 'heartbeat',
      agentId: config.agentId,
      secret: config.secret,
      data: {
        hostname: os.hostname(),
        ipAddress: getLocalIpAddress(),
        platform: os.platform(),
        arch: os.arch(),
        ...stats
      },
      timestamp: Date.now()
    };
    
    ws.send(JSON.stringify(message));
    console.log(`[Agent] 心跳已发送 - CPU: ${stats.cpu}%, 内存: ${stats.memory.percentage}%`);
  } catch (error) {
    console.error('[Agent] 发送心跳失败:', error.message);
  }
}

// 处理命令
async function handleCommand(commandData) {
  console.log(`[Agent] 处理命令: ${commandData.type}`);
  
  switch (commandData.type) {
    case 'install_polling_client':
      await installPollingClient(commandData.script);
      break;
    case 'deploy':
      await executeDeployScript(commandData.config);
      break;
    case 'restart':
      console.log('[Agent] 收到重启命令，3秒后重启...');
      setTimeout(() => {
        process.exit(0); // systemd会自动重启
      }, 3000);
      break;
    default:
      console.log(`[Agent] 未知命令类型: ${commandData.type}`);
  }
}

// 发送安装进度消息
function sendInstallProgress(step, message, progress, status = 'running') {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const progressMessage = {
      type: 'install_progress',
      agentId: config.agentId,
      secret: config.secret,
      data: {
        step,
        message,
        progress,
        status
      },
      timestamp: Date.now()
    };
    ws.send(JSON.stringify(progressMessage));
  }
}

// 安装GOST轮询客户端
async function installPollingClient(script) {
  console.log('[Agent] 开始安装GOST轮询客户端...');
  sendInstallProgress('init', '开始安装GOST轮询客户端...', 0, 'running');
  
  return new Promise((resolve, reject) => {
    try {
      // 将脚本保存到临时文件
      const scriptPath = `/tmp/install_gost_polling_${Date.now()}.sh`;
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      console.log(`[Agent] 脚本已保存到: ${scriptPath}`);
      sendInstallProgress('save_script', '脚本已保存到临时文件', 5, 'running');
      
      // 使用spawn执行脚本，逐行读取输出
      const { spawn } = require('child_process');
      const child = spawn('bash', [scriptPath]);
      
      let stdout = '';
      let stderr = '';
      let currentProgress = 10;
      
      // 监听标准输出
      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        console.log(`[Agent] 安装输出: ${output.trim()}`);
        
        // 根据输出内容判断安装阶段
        if (output.includes('Node.js')) {
          sendInstallProgress('nodejs', '正在安装Node.js...', 20, 'running');
          currentProgress = 20;
        } else if (output.includes('创建工作目录') || output.includes('写入')) {
          sendInstallProgress('setup', '正在配置客户端...', 50, 'running');
          currentProgress = 50;
        } else if (output.includes('systemd') || output.includes('服务')) {
          sendInstallProgress('service', '正在配置systemd服务...', 70, 'running');
          currentProgress = 70;
        } else if (output.includes('启动') || output.includes('enable')) {
          sendInstallProgress('start', '正在启动服务...', 85, 'running');
          currentProgress = 85;
        } else if (output.includes('成功') || output.includes('active')) {
          sendInstallProgress('complete', '安装完成！', 95, 'running');
          currentProgress = 95;
        } else if (currentProgress < 90) {
          // 有输出就增加进度
          currentProgress = Math.min(currentProgress + 2, 90);
          sendInstallProgress('progress', output.trim().substring(0, 100), currentProgress, 'running');
        }
      });
      
      // 监听错误输出
      child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        console.log(`[Agent] 安装错误输出: ${output.trim()}`);
      });
      
      // 监听进程退出
      child.on('close', (code) => {
        // 删除临时脚本
        try {
          fs.unlinkSync(scriptPath);
        } catch (err) {
          // 忽略删除错误
        }
        
        if (code === 0) {
          console.log('[Agent] GOST轮询客户端安装成功');
          sendInstallProgress('success', 'GOST轮询客户端安装成功！', 100, 'success');
          
          // 发送最终结果
          if (ws && ws.readyState === WebSocket.OPEN) {
            const resultMessage = {
              type: 'install_result',
              agentId: config.agentId,
              secret: config.secret,
              data: {
                success: true,
                message: 'GOST轮2户端安装成功',
                output: stdout,
                error: stderr || null
              },
              timestamp: Date.now()
            };
            ws.send(JSON.stringify(resultMessage));
          }
          
          resolve();
        } else {
          console.error(`[Agent] GOST轮询客户端安装失败，退出码: ${code}`);
          sendInstallProgress('error', `安装失败（退出码: ${code}）`, currentProgress, 'error');
          
          // 发送失败结果
          if (ws && ws.readyState === WebSocket.OPEN) {
            const resultMessage = {
              type: 'install_result',
              agentId: config.agentId,
              secret: config.secret,
              data: {
                success: false,
                message: 'GOST轮询客户端安装失败',
                output: stdout,
                error: stderr || `退出码: ${code}`
              },
              timestamp: Date.now()
            };
            ws.send(JSON.stringify(resultMessage));
          }
          
          reject(new Error(`安装失败，退出码: ${code}`));
        }
      });
      
      // 设置超时（10分钟）
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
          sendInstallProgress('error', '安装超时', currentProgress, 'error');
          reject(new Error('安装超时'));
        }
      }, 600000);
      
    } catch (error) {
      console.error(`[Agent] GOST轮询客户端安装失败: ${error.message}`);
      sendInstallProgress('error', `安装失败: ${error.message}`, 0, 'error');
      
      // 发送失败结果
      if (ws && ws.readyState === WebSocket.OPEN) {
        const resultMessage = {
          type: 'install_result',
          agentId: config.agentId,
          secret: config.secret,
          data: {
            success: false,
            message: 'GOST轮询客户端安装失败',
            output: '',
            error: error.message
          },
          timestamp: Date.now()
        };
        ws.send(JSON.stringify(resultMessage));
      }
      
      reject(error);
    }
  });
}

// 执行部署脚本
async function executeDeployScript(deployData) {
  console.log(`[Agent] 开始执行部署任务: ${deployData.nodeId}`);
  
  try {
    // 将脚本保存到临时文件
    const scriptPath = `/tmp/deploy_${deployData.nodeId}_${Date.now()}.sh`;
    fs.writeFileSync(scriptPath, deployData.script, { mode: 0o755 });
    
    // 执行脚本
    const { stdout, stderr } = await execAsync(`bash ${scriptPath}`, {
      timeout: 300000, // 5分钟超时
      maxBuffer: 10 * 1024 * 1024 // 10MB缓冲区
    });
    
    // 删除临时脚本
    try {
      fs.unlinkSync(scriptPath);
    } catch (err) {
      // 忽略删除错误
    }
    
    // 发送部署结果
    const resultMessage = {
      type: 'deploy_result',
      agentId: config.agentId,
      secret: config.secret,
      data: {
        nodeId: deployData.nodeId,
        success: true,
        output: stdout,
        error: stderr || null
      },
      timestamp: Date.now()
    };
    
    ws.send(JSON.stringify(resultMessage));
    console.log(`[Agent] 部署任务完成: ${deployData.nodeId}`);
  } catch (error) {
    console.error(`[Agent] 部署任务失败: ${error.message}`);
    
    // 发送失败结果
    const resultMessage = {
      type: 'deploy_result',
      agentId: config.agentId,
      secret: config.secret,
      data: {
        nodeId: deployData.nodeId,
        success: false,
        output: error.stdout || '',
        error: error.message
      },
      timestamp: Date.now()
    };
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(resultMessage));
    }
  }
}

// 处理服务器消息
function handleMessage(data) {
  try {
    const message = JSON.parse(data);
    console.log(`[Agent] 收到消息: ${message.type}`);
    
    switch (message.type) {
      case 'command':
        // 处理命令消息
        if (message.data && message.data.type) {
          handleCommand(message.data);
        }
        break;
      case 'deploy':
        executeDeployScript(message.data);
        break;
      case 'restart':
        console.log('[Agent] 收到重启命令，3秒后重启...');
        setTimeout(() => {
          process.exit(0); // systemd会自动重启
        }, 3000);
        break;
      default:
        console.log(`[Agent] 未知消息类型: ${message.type}`);
    }
  } catch (error) {
    console.error('[Agent] 处理消息失败:', error.message);
  }
}

// 连接到WebSocket服务器
function connect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  console.log(`[Agent] 正在连接到服务器: ${config.serverUrl}`);
  
  try {
    ws = new WebSocket(config.serverUrl, {
      headers: {
        'User-Agent': 'VPS-Agent/1.0'
      }
    });
    
    ws.on('open', () => {
      console.log('[Agent] WebSocket连接已建立');
      isConnected = true;
      
      // 发送注册消息
      const registerMessage = {
        type: 'register',
        agentId: config.agentId,
        secret: config.secret,
        data: {
          name: config.name,
          hostname: os.hostname(),
          ipAddress: getLocalIpAddress(),
          platform: os.platform(),
          arch: os.arch()
        },
        timestamp: Date.now()
      };
      
      ws.send(JSON.stringify(registerMessage));
      console.log('[Agent] 注册消息已发送');
      
      // 立即发送第一次心跳
      sendHeartbeat();
      
      // 启动心跳定时器（每30秒）
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      heartbeatInterval = setInterval(sendHeartbeat, 30000);
    });
    
    ws.on('message', (data) => {
      handleMessage(data.toString());
    });
    
    ws.on('error', (error) => {
      console.error('[Agent] WebSocket错误:', error.message);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`[Agent] WebSocket连接已关闭: ${code} - ${reason}`);
      isConnected = false;
      
      // 清理心跳定时器
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      // 5秒后重连
      console.log('[Agent] 5秒后尝试重新连接...');
      reconnectTimeout = setTimeout(connect, 5000);
    });
  } catch (error) {
    console.error('[Agent] 连接失败:', error.message);
    reconnectTimeout = setTimeout(connect, 5000);
  }
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[Agent] 收到SIGINT信号，正在退出...');
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Agent] 收到SIGTERM信号，正在退出...');
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

// 启动Agent
console.log('=== VPS隧道管理面板 - Agent客户端 ===');
console.log(`Agent ID: ${config.agentId}`);
console.log(`Agent名称: ${config.name}`);
console.log(`服务器地址: ${config.serverUrl}`);
console.log('=====================================');
connect();
