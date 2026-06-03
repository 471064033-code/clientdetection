/**
 * MTR API 服务
 * 轻量级后端，在服务器上执行真实的 mtr 命令并返回 JSON 结果
 * 
 * 部署方式：
 *   1. 在 Linux 服务器上安装 mtr: apt install mtr-tiny / yum install mtr
 *   2. npm install 安装依赖
 *   3. node index.js 启动服务（或用 pm2 / systemd）
 *   4. 前端 CONFIG.mtrApiBase 填入此服务地址
 * 
 * 安全说明：
 *   - 已限制目标只能是 IP 或域名（防注入）
 *   - 有频率限制（每 IP 每分钟 3 次）
 *   - CORS 已开启，支持前端跨域调用
 */

const http = require('http');
const { exec } = require('child_process');
const url = require('url');

// ==================== 配置 ====================
const PORT = process.env.MTR_PORT || 3089;
const MAX_HOPS = 30;
const PACKET_COUNT = 10;
const TIMEOUT = 60000; // 60s 超时
const ALLOWED_ORIGINS = ['*']; // 生产环境改为具体域名

// 频率限制：每 IP 每分钟最多 3 次
const rateLimitMap = new Map();
const RATE_LIMIT = 3;
const RATE_WINDOW = 60000;

// ==================== 工具函数 ====================

// 验证目标是否为合法的 IP 或域名
function isValidTarget(target) {
    if (!target || target.length > 253) return false;
    // IPv4
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) return true;
    // IPv6 简单校验
    if (/^[0-9a-fA-F:]+$/.test(target) && target.includes(':')) return true;
    // 域名
    if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(target)) return true;
    return false;
}

// 频率限制检查
function checkRateLimit(clientIP) {
    const now = Date.now();
    const key = clientIP;
    
    if (!rateLimitMap.has(key)) {
        rateLimitMap.set(key, []);
    }
    
    const timestamps = rateLimitMap.get(key).filter(t => now - t < RATE_WINDOW);
    rateLimitMap.set(key, timestamps);
    
    if (timestamps.length >= RATE_LIMIT) {
        return false;
    }
    
    timestamps.push(now);
    return true;
}

// 解析 mtr JSON 输出
function parseMtrOutput(jsonStr) {
    try {
        const data = JSON.parse(jsonStr);
        const report = data.report;
        const hops = report.hubs.map((hub, index) => ({
            hop: index + 1,
            ip: hub.host || '*',
            hostname: hub.host || '*',
            loss: `${hub['Loss%'].toFixed(1)}%`,
            sent: String(hub.Snt),
            best: `${hub.Best.toFixed(1)} ms`,
            avg: `${hub.Avg.toFixed(1)} ms`,
            worst: `${hub.Wrst.toFixed(1)} ms`,
            stdev: `${hub.StDev.toFixed(1)} ms`
        }));

        const losses = report.hubs.map(h => h['Loss%']);
        const avgs = report.hubs.map(h => h.Avg);

        return {
            target: report.mtr.dst,
            source: report.mtr.src || 'server',
            hops,
            summary: {
                avgLoss: `${(losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(1)}%`,
                avgLatency: `${(avgs.reduce((a, b) => a + b, 0) / avgs.length).toFixed(1)} ms`,
                totalHops: hops.length
            },
            raw: data
        };
    } catch (e) {
        throw new Error('Failed to parse mtr output: ' + e.message);
    }
}

// 执行 mtr 命令
function executeMTR(target) {
    return new Promise((resolve, reject) => {
        // mtr --json 模式输出 JSON 格式
        // -c: 发送包数量, -m: 最大跳数, -n: 不做DNS反解(加速), --report: 报告模式
        const cmd = `mtr --json -c ${PACKET_COUNT} -m ${MAX_HOPS} --report ${target}`;
        
        const child = exec(cmd, { timeout: TIMEOUT, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                // mtr 可能返回非 0 退出码但仍有有效输出
                if (stdout && stdout.trim().startsWith('{')) {
                    try {
                        const result = parseMtrOutput(stdout);
                        resolve(result);
                        return;
                    } catch (e) {
                        // fall through
                    }
                }
                reject(new Error(`MTR execution failed: ${error.message}`));
                return;
            }
            
            if (!stdout || !stdout.trim()) {
                reject(new Error('MTR returned empty output'));
                return;
            }

            try {
                const result = parseMtrOutput(stdout);
                resolve(result);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ==================== HTTP 服务 ====================
const server = http.createServer(async (req, res) => {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 健康检查
    if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'mtr-api', timestamp: new Date().toISOString() }));
        return;
    }

    // MTR 接口
    if (pathname === '/mtr') {
        const target = parsedUrl.query.target;
        const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

        // 参数校验
        if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required parameter: target', code: 400 }));
            return;
        }

        if (!isValidTarget(target)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid target format. Must be a valid IP or domain.', code: 400 }));
            return;
        }

        // 频率限制
        if (!checkRateLimit(clientIP)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limit exceeded. Max 3 requests per minute.', code: 429 }));
            return;
        }

        try {
            console.log(`[${new Date().toISOString()}] MTR request: ${target} from ${clientIP}`);
            const result = await executeMTR(target);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] MTR error: ${error.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message, code: 500 }));
        }
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', code: 404 }));
});

server.listen(PORT, () => {
    console.log(`🚀 MTR API Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   MTR endpoint: http://localhost:${PORT}/mtr?target=8.8.8.8`);
    console.log('');
    console.log('   Make sure mtr is installed: apt install mtr-tiny');
});

// 清理过期频率限制数据
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimitMap) {
        const valid = timestamps.filter(t => now - t < RATE_WINDOW);
        if (valid.length === 0) {
            rateLimitMap.delete(key);
        } else {
            rateLimitMap.set(key, valid);
        }
    }
}, 60000);
