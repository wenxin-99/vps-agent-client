#!/usr/bin/env node

/**
 * VPS隧道管理面板 - Agent客户端
 * 安装在VPS上，自动连接到管理面板并上报状态
 */

const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, 'config.json');
const VERSION = '1.0.0';

// 读取配置
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.error('❌ 配置文件不存在:', CONFIG_FILE);
      console.error('请确保 config.json 文件存在并包含正确的配置');
      process.exit(1);
    }
    
    const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(configData);
    
    if (!config.serverUrl || !config.secret) {
      console.error('❌ 配置文件缺少必要字段: serverUrl 或 secret');
      process.exit(1);
    }
    
    return config;
  } catch (error) {
    console.error('❌ 配置文件加载失败:', error.message);
    process.exit(1);
  }
}

// 获取系统信息
async function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = os.uptime();
  
  // CPU使用率（简化计算）
  let cpuUsage = 0;
  if (cpus.length > 0) {
    const cpu = cpus[0];
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    cpuUsage = ((total - idle) / total) * 100;
  }
  
  // 内存使用率
  const memoryUsage = ((totalMem - freeMem) / totalMem) * 100;
  
  // 网络流量（从/proc/net/dev读取，仅Linux）
  let bytesReceived = 0;
  let bytesTransmitted = 0;
  
  if (os.platform() === 'linux') {
    try {
      const netDev = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = netDev.split('\n');
      
      for (const line of lines) {
        if (line.includes(':') && !line.includes('lo:')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10) {
            bytesReceived += parseInt(parts[1]) || 0;
            bytesTransmitted += parseInt(parts[9]) || 0;
          }
        }
      }
    } catch (error) {
      console.warn('⚠️ 无法读取网络流量:', error.message);
    }
  }
  
  return {
    hostname: os.hostname(),
    ipAddress: getLocalIP(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    version: VERSION,
    cpuUsage: parseFloat(cpuUsage.toFixed(2)),
    memoryUsage: parseFloat(memoryUsage.toFixed(2)),
    uptime: Math.floor(uptime),
    bytesReceived,
    bytesTransmitted,
  };
}

// 获取本地IP地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Agent类
class VPSAgent {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.reconnectDelay = 5000; // 5秒重连
    this.heartbeatInterval = 30000; // 30秒心跳
    this.heartbeatTimer = null;
    this.isRegistered = false;
  }
  
  // 连接到服务器
  connect() {
    const wsUrl = this.config.serverUrl.replace(/^http/, 'ws') + '/api/agent/ws';
    console.log(`🔗 正在连接到服务器: ${wsUrl}`);
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.on('open', () => {
      console.log('✅ 已连接到服务器');
      this.register();
    });
    
    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });
    
    this.ws.on('close', () => {
      console.log('🔌 连接已断开');
      this.isRegistered = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
    
    this.ws.on('error', (error) => {
      console.error('❌ WebSocket错误:', error.message);
    });
  }
  
  // 注册Agent
  async register() {
    try {
      const systemInfo = await getSystemInfo();
      
      const registerMessage = {
        type: 'register',
        data: {
          secret: this.config.secret,
          ...systemInfo,
        },
      };
      
      this.ws.send(JSON.stringify(registerMessage));
      console.log('📤 已发送注册请求');
    } catch (error) {
      console.error('❌ 注册失败:', error.message);
    }
  }
  
  // 发送心跳
  async sendHeartbeat() {
    if (!this.isRegistered || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    
    try {
      const systemInfo = await getSystemInfo();
      
      const heartbeatMessage = {
        type: 'heartbeat',
        data: systemInfo,
      };
      
      this.ws.send(JSON.stringify(heartbeatMessage));
      console.log('💓 已发送心跳');
    } catch (error) {
      console.error('❌ 心跳发送失败:', error.message);
    }
  }
  
  // 启动心跳定时器
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatInterval);
    console.log(`⏰ 心跳定时器已启动 (间隔: ${this.heartbeatInterval / 1000}秒)`);
  }
  
  // 停止心跳定时器
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  // 处理服务器消息
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'registered':
          console.log('✅ 注册成功, Agent ID:', message.agentId);
          this.isRegistered = true;
          this.startHeartbeat();
          // 立即发送一次心跳
          this.sendHeartbeat();
          break;
          
        case 'heartbeat_ack':
          // 心跳确认，无需处理
          break;
          
        case 'command':
          this.handleCommand(message.data);
          break;
          
        case 'error':
          console.error('❌ 服务器错误:', message.message);
          if (message.message === 'Invalid secret') {
            console.error('❌ 密钥无效，请检查配置文件');
            process.exit(1);
          }
          break;
          
        default:
          console.warn('⚠️ 未知消息类型:', message.type);
      }
    } catch (error) {
      console.error('❌ 消息处理失败:', error.message);
    }
  }
  
  // 处理远程命令
  async handleCommand(command) {
    console.log('📥 收到远程命令:', command.type);
    
    switch (command.type) {
      case 'ping':
        this.sendResponse(command.requestId, { success: true, message: 'pong' });
        break;
        
      case 'restart':
        console.log('🔄 重启Agent...');
        this.sendResponse(command.requestId, { success: true, message: 'Restarting...' });
        setTimeout(() => {
          process.exit(0); // systemd会自动重启
        }, 1000);
        break;
        
      case 'execute':
        await this.executeCommand(command.requestId, command.command);
        break;
        
      case 'deploy':
        await this.deployProtocol(command.requestId, command.config);
        break;
        
      case 'reload_gost_config':
        await this.reloadGostConfig(command.requestId, command.config);
        break;
        
      default:
        this.sendResponse(command.requestId, { success: false, message: 'Unknown command' });
    }
  }
  
  // 重载GOST配置
  async reloadGostConfig(requestId, config) {
    console.log('📥 收到GOST配置更新请求');
    
    try {
      const configPath = '/etc/gost/config.json';
      
      // 确保配置目录存在
      await execPromise('mkdir -p /etc/gost');
      
      // 写入配置文件
      const configJson = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, configJson, 'utf8');
      console.log(`✅ GOST配置已写入: ${configPath}`);
      console.log(`📝 配置内容: ${configJson.substring(0, 200)}...`);
      
      // 重启GOST服务
      console.log('🔄 正在重启GOST服务...');
      try {
        await execPromise('systemctl restart gost');
        console.log('✅ GOST服务重启成功');
        
        // 等待服务启动
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 检查服务状态
        const { stdout: statusOutput } = await execPromise('systemctl is-active gost');
        const isActive = statusOutput.trim() === 'active';
        
        this.sendResponse(requestId, {
          success: true,
          message: 'GOST配置已更新并重启服务',
          serviceStatus: isActive ? 'active' : 'inactive',
        });
      } catch (restartError) {
        console.error('⚠️ GOST服务重启失败:', restartError.message);
        this.sendResponse(requestId, {
          success: true,
          message: 'GOST配置已更新，但服务重启失败',
          error: restartError.message,
        });
      }
    } catch (error) {
      console.error('❌ GOST配置更新失败:', error.message);
      this.sendResponse(requestId, {
        success: false,
        error: error.message,
      });
    }
  }
  
  // 部署协议
  async deployProtocol(requestId, config) {
    console.log(`📦 正在部署协议: ${config.protocol}`);
    
    try {
      // 将脚本保存到临时文件
      const scriptPath = `/tmp/deploy_${config.protocol}_${Date.now()}.sh`;
      fs.writeFileSync(scriptPath, config.script, { mode: 0o755 });
      
      // 执行部署脚本
      const { stdout, stderr } = await execPromise(`bash ${scriptPath}`);
      
      // 清理临时文件
      fs.unlinkSync(scriptPath);
      
      console.log(`✅ 协议 ${config.protocol} 部署成功`);
      this.sendResponse(requestId, {
        success: true,
        message: `协议 ${config.protocol} 部署成功`,
        stdout,
        stderr,
      });
    } catch (error) {
      console.error(`❌ 协议部署失败:`, error.message);
      this.sendResponse(requestId, {
        success: false,
        error: error.message,
      });
    }
  }
  
  // 执行Shell命令
  async executeCommand(requestId, command) {
    try {
      const { stdout, stderr } = await execPromise(command);
      this.sendResponse(requestId, {
        success: true,
        stdout,
        stderr,
      });
    } catch (error) {
      this.sendResponse(requestId, {
        success: false,
        error: error.message,
      });
    }
  }
  
  // 发送响应
  sendResponse(requestId, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'response',
        requestId,
        data,
      }));
    }
  }
  
  // 安排重连
  scheduleReconnect() {
    console.log(`⏳ ${this.reconnectDelay / 1000}秒后尝试重连...`);
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }
  
  // 启动Agent
  start() {
    console.log('🚀 VPS Agent 启动中...');
    console.log(`📋 版本: ${VERSION}`);
    console.log(`🔧 服务器: ${this.config.serverUrl}`);
    this.connect();
  }
}

// 主函数
function main() {
  console.log('='.repeat(50));
  console.log('VPS隧道管理面板 - Agent客户端');
  console.log('='.repeat(50));
  
  const config = loadConfig();
  const agent = new VPSAgent(config);
  agent.start();
  
  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n👋 收到退出信号，正在关闭...');
    agent.stopHeartbeat();
    if (agent.ws) {
      agent.ws.close();
    }
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n👋 收到终止信号，正在关闭...');
    agent.stopHeartbeat();
    if (agent.ws) {
      agent.ws.close();
    }
    process.exit(0);
  });
}

// 运行
if (require.main === module) {
  main();
}

module.exports = VPSAgent;
