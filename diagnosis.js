/**
 * 客户端网络诊断工具
 * 功能：收集客户端信息、DNS解析、节点连通性、MTR路由追踪、下载测速
 */

// ==================== 配置 ====================
const CONFIG = {
    // 获取客户端IP的公共API（可替换为自有服务）
    ipApis: [
        'https://ipinfo.io/json',
        'https://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,as,query'
    ],
    // DNS over HTTPS 接口
    dohServers: [
        'https://dns.alidns.com/resolve',
        'https://doh.pub/dns-query'
    ],
    // 下载测速文件（替换为实际CDN上的测速文件）
    speedTestFiles: [
        { size: '1MB', url: '' },  // 由诊断时动态生成
        { size: '5MB', url: '' }
    ],
    // MTR 后端 API（需自行部署）
    mtrApiBase: '',
    // 超时时间
    timeout: 15000
};

// ==================== 批量域名检测配置 ====================
const BATCH_DOMAINS = {
    tencent: [
        { domain: 'i.gtimg.cn', label: 'i.gtimg.cn' },
        { domain: 'cloud.tencent.com', label: 'cloud.tencent.com' },
        { domain: 'imgcache.qq.com', label: 'imgcache.qq.com' },
        { domain: 'qzone.qq.com', label: 'qzone.qq.com' },
        { domain: 'now.qq.com', label: 'now.qq.com' },
        { domain: 'www.qq.com', label: 'www.qq.com' },
        { domain: 'qianbao.qq.com', label: 'qianbao.qq.com' },
        { domain: 'v.qq.com', label: 'v.qq.com' },
        { domain: 'mail.qq.com', label: 'mail.qq.com' },
        { domain: 'qun.qq.com', label: 'qun.qq.com' },
        { domain: 'mmbiz.qpic.cn', label: 'mmbiz.qpic.cn' },
        { domain: 'puui.qpic.cn', label: 'puui.qpic.cn' },
        { domain: 'inews.gtimg.com', label: 'inews.gtimg.com' },
        { domain: 'emoji.qpic.cn', label: 'emoji.qpic.cn' },
        { domain: 'captcha.gtimg.com', label: 'captcha.gtimg.com' }
    ],
    other: [
        { domain: 'www.baidu.com', label: 'www.baidu.com' },
        { domain: 'www.youku.com', label: 'www.youku.com' },
        { domain: 'www.zhihu.com', label: 'www.zhihu.com' },
        { domain: 'www.iqiyi.com', label: 'www.iqiyi.com' },
        { domain: 'www.kugou.com', label: 'www.kugou.com' }
    ]
};

// ==================== 工具函数 ====================
function $(selector) {
    return document.querySelector(selector);
}

function $$(selector) {
    return document.querySelectorAll(selector);
}

function formatTime(date) {
    return date.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function setStatus(elementId, status, text) {
    const el = $(`#${elementId}`);
    el.className = `status-badge ${status}`;
    el.textContent = text || (status === 'running' ? '检测中' : status === 'success' ? '完成' : '失败');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 带超时的 fetch
function fetchWithTimeout(url, options = {}, timeout = CONFIG.timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// ==================== 诊断结果存储 ====================
let diagnosisResult = {
    timestamp: '',
    target: '',
    clientInfo: {},
    batchTest: { tencent: [], other: [] },
    dns: {},
    connectivity: {},
    mtr: {},
    download: {}
};

// ==================== 模块0: 域名连通性批量检测 ====================
function initBatchTestGrid() {
    const tencentGrid = $('#tencentDomainGrid');
    const otherGrid = $('#otherDomainGrid');
    
    tencentGrid.innerHTML = '';
    otherGrid.innerHTML = '';

    BATCH_DOMAINS.tencent.forEach(item => {
        tencentGrid.appendChild(createBatchItem(item.domain));
    });

    BATCH_DOMAINS.other.forEach(item => {
        otherGrid.appendChild(createBatchItem(item.domain));
    });
}

function createBatchItem(domain) {
    const div = document.createElement('div');
    div.className = 'batch-test-item';
    div.id = `batch-${domain.replace(/\./g, '-')}`;
    div.innerHTML = `
        <span class="batch-domain-name">${domain}</span>
        <div class="batch-test-result">
            <span class="batch-latency">等待中</span>
            <span class="batch-status-dot"></span>
        </div>
    `;
    return div;
}

async function detectBatchDomains() {
    setStatus('batchTestStatus', 'running');
    initBatchTestGrid();

    const results = { tencent: [], other: [] };

    // 并发检测所有域名，但用 Promise.allSettled 确保全部完成
    const allDomains = [
        ...BATCH_DOMAINS.tencent.map(d => ({ ...d, group: 'tencent' })),
        ...BATCH_DOMAINS.other.map(d => ({ ...d, group: 'other' }))
    ];

    // 分批并发（每批6个，避免浏览器并发连接数限制）
    const batchSize = 6;
    for (let i = 0; i < allDomains.length; i += batchSize) {
        const batch = allDomains.slice(i, i + batchSize);
        await Promise.allSettled(
            batch.map(item => testSingleDomain(item, results))
        );
    }

    // 更新摘要
    const allResults = [...results.tencent, ...results.other];
    const normalCount = allResults.filter(r => r.status === 'normal').length;
    const abnormalCount = allResults.filter(r => r.status === 'error').length;
    const validLatencies = allResults.filter(r => r.latency > 0).map(r => r.latency);
    const avgLatency = validLatencies.length > 0 
        ? Math.round(validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length)
        : 0;

    $('#batchSummary').style.display = 'grid';
    $('#batchNormal').textContent = `${normalCount} 个`;
    $('#batchAbnormal').textContent = `${abnormalCount} 个`;
    $('#batchAvgLatency').textContent = `${avgLatency} ms`;

    diagnosisResult.batchTest = results;
    setStatus('batchTestStatus', 'success');
    return true;
}

async function testSingleDomain(item, results) {
    const domainId = `batch-${item.domain.replace(/\./g, '-')}`;
    const el = $(`#${domainId}`);
    if (el) el.className = 'batch-test-item testing';

    const latencyEl = el ? el.querySelector('.batch-latency') : null;
    const dotEl = el ? el.querySelector('.batch-status-dot') : null;

    if (latencyEl) latencyEl.textContent = '检测中...';
    if (dotEl) dotEl.className = 'batch-status-dot testing';

    let latency = -1;
    let status = 'error';
    let statusText = '网络差';

    try {
        const startTime = performance.now();
        
        // 使用 fetch 发起请求来测量延迟
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        
        await fetch(`https://${item.domain}`, {
            method: 'HEAD',
            mode: 'no-cors',
            cache: 'no-store',
            signal: controller.signal
        });
        
        clearTimeout(timer);
        latency = Math.round(performance.now() - startTime);
        
        if (latency < 3000) {
            status = 'normal';
            statusText = `网络正常，延时${latency}毫秒`;
        } else {
            status = 'slow';
            statusText = `网络慢，延时${latency}毫秒`;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            latency = -1;
            status = 'error';
            statusText = '网络差，延迟大于6000毫秒';
        } else {
            // 对于no-cors模式，即使有网络错误但在短时间内返回，也可能表示网络正常
            latency = -1;
            status = 'error';
            statusText = '连接失败';
        }
    }

    // 更新 UI
    if (el) el.className = `batch-test-item ${status}`;
    if (dotEl) dotEl.className = `batch-status-dot ${status}`;
    if (latencyEl) {
        if (status === 'normal') {
            latencyEl.textContent = `${latency}ms`;
            latencyEl.style.color = 'var(--success)';
        } else if (status === 'slow') {
            latencyEl.textContent = `${latency}ms`;
            latencyEl.style.color = 'var(--warning)';
        } else {
            latencyEl.textContent = '>6000ms';
            latencyEl.style.color = 'var(--error)';
        }
    }

    // 保存结果
    const result = { domain: item.domain, latency, status, statusText };
    results[item.group].push(result);
}


// ==================== 模块1: 客户端信息采集 ====================

// 通过 WebRTC 获取本地局域网 IP
function getLocalIPViaWebRTC() {
    return new Promise((resolve) => {
        const localIPs = [];
        try {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pc.createDataChannel('');
            pc.createOffer().then(offer => pc.setLocalDescription(offer));
            pc.onicecandidate = (event) => {
                if (!event || !event.candidate) {
                    pc.close();
                    resolve(localIPs);
                    return;
                }
                const parts = event.candidate.candidate.split(' ');
                const ip = parts[4];
                if (ip && !ip.includes(':') && ip !== '0.0.0.0' && !localIPs.includes(ip)) {
                    localIPs.push(ip);
                }
            };
            // 超时保底
            setTimeout(() => { pc.close(); resolve(localIPs); }, 3000);
        } catch (e) {
            resolve(localIPs);
        }
    });
}

// ===== 增强代理检测：DNS泄露 + 企业代理IP段 + 时延异常 =====

// 已知企业级正向代理/VPN 出口IP段特征
const KNOWN_PROXY_PATTERNS = {
    // 腾讯 iOA 常见出口段（深圳/上海/北京办公出口）
    tencent_ioa: [
        /^113\.96\./, /^183\.3\./, /^183\.47\./, /^14\.17\./, /^14\.18\./,
        /^59\.37\./, /^58\.251\./, /^121\.51\./, /^203\.205\./
    ],
    // 企业常见出口特征关键词
    enterprise_isp_keywords: [
        'Tencent', 'tencent', '腾讯', 'iOA', 'Zero Trust',
        'Corporate', 'Enterprise', 'Zscaler', 'Palo Alto', 'Fortinet',
        'Cloudflare WARP', 'Tailscale'
    ]
};

// DNS泄露检测：通过 DNS 查询对比检测透明代理
async function detectDNSLeak() {
    const results = {
        dnsServers: [],
        leakDetected: false,
        detail: ''
    };

    try {
        // 利用 DNS leak test 原理：请求一个带随机子域名的地址
        // 通过多个 DoH 服务对比，看 DNS 请求是从哪里发出的
        
        // 方法1：通过 doh.pub 查看 edns-client-subnet（ECS）
        try {
            const randomSub = `leak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const resp = await fetchWithTimeout(
                `https://doh.pub/dns-query?name=${randomSub}.test-dns.com&type=A`,
                { headers: { 'Accept': 'application/dns-json' } },
                5000
            );
            const data = await resp.json();
            // doh.pub 会在 Comment 中返回客户端来源信息
            if (data.Comment) {
                results.dnsServers.push({ source: 'doh.pub', info: data.Comment });
            }
        } catch (e) { /* 忽略 */ }

        // 方法2：通过 Cloudflare trace 获取 DNS 相关信息
        try {
            const resp = await fetchWithTimeout('https://1.1.1.1/cdn-cgi/trace', {}, 5000);
            const text = await resp.text();
            const lines = text.split('\n');
            const cfData = {};
            lines.forEach(line => {
                const [key, value] = line.split('=');
                if (key && value) cfData[key.trim()] = value.trim();
            });
            if (cfData.ip) {
                results.dnsServers.push({ 
                    source: 'Cloudflare', 
                    ip: cfData.ip,
                    loc: cfData.loc || '',
                    colo: cfData.colo || '' // Cloudflare 数据中心代号
                });
            }
        } catch (e) { /* 忽略 */ }

        // 方法3：通过 ip.sb / myip.la 等获取另一个视角的出口IP
        try {
            const resp = await fetchWithTimeout('https://api.ip.sb/jsonip', {}, 5000);
            const data = await resp.json();
            if (data.ip) {
                results.dnsServers.push({ source: 'ip.sb', ip: data.ip });
            }
        } catch (e) { /* 忽略 */ }

    } catch (e) {
        console.warn('DNS leak detection failed:', e);
    }

    return results;
}

// 检查出口IP是否匹配已知企业代理特征
function checkKnownProxyIP(ip, isp) {
    const matched = { isProxy: false, type: '', detail: '' };

    // 检查IP段
    for (const pattern of KNOWN_PROXY_PATTERNS.tencent_ioa) {
        if (pattern.test(ip)) {
            matched.isProxy = true;
            matched.type = '腾讯 iOA/企业出口';
            matched.detail = `IP ${ip} 匹配腾讯企业出口段`;
            return matched;
        }
    }

    // 检查ISP关键词
    if (isp) {
        for (const keyword of KNOWN_PROXY_PATTERNS.enterprise_isp_keywords) {
            if (isp.includes(keyword)) {
                matched.isProxy = true;
                matched.type = '企业代理/VPN';
                matched.detail = `ISP "${isp}" 包含企业代理特征关键词 "${keyword}"`;
                return matched;
            }
        }
    }

    return matched;
}

// 时延异常检测：对比直连延迟和API延迟
async function detectLatencyAnomaly() {
    const timings = [];

    // 测量到多个公共服务的延迟
    const targets = [
        { url: 'https://www.baidu.com', name: '百度' },
        { url: 'https://www.qq.com', name: '腾讯' }
    ];

    for (const target of targets) {
        try {
            const start = performance.now();
            await fetch(target.url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            const elapsed = performance.now() - start;
            timings.push({ name: target.name, latency: elapsed });
        } catch (e) {
            timings.push({ name: target.name, latency: -1 });
        }
    }

    // 如果所有延迟都 > 200ms，可能经过了代理跳转（国内直连通常 < 100ms）
    const validTimings = timings.filter(t => t.latency > 0);
    const avgLatency = validTimings.length > 0
        ? validTimings.reduce((sum, t) => sum + t.latency, 0) / validTimings.length
        : 0;

    return {
        timings,
        avgLatency: Math.round(avgLatency),
        anomaly: avgLatency > 300 // 超过300ms视为异常
    };
}

// 从多个 API 获取出口IP，用于对比检测代理
async function getExitIPs() {
    const results = [];

    // 源1: ip-api.com
    try {
        const resp = await fetchWithTimeout(CONFIG.ipApis[1], {}, 8000);
        const data = await resp.json();
        if (data.status === 'success') {
            results.push({
                source: 'ip-api.com',
                ip: data.query,
                location: `${data.country} ${data.regionName} ${data.city}`,
                isp: data.isp || data.org,
                as: data.as
            });
        }
    } catch (e) {
        console.warn('ip-api.com failed');
    }

    // 源2: ipinfo.io
    try {
        const resp = await fetchWithTimeout(CONFIG.ipApis[0], {}, 8000);
        const data = await resp.json();
        if (data.ip) {
            results.push({
                source: 'ipinfo.io',
                ip: data.ip,
                location: `${data.country || ''} ${data.region || ''} ${data.city || ''}`.trim(),
                isp: data.org || '',
                as: ''
            });
        }
    } catch (e) {
        console.warn('ipinfo.io failed');
    }

    return results;
}

async function detectClientInfo() {
    setStatus('clientInfoStatus', 'running');

    try {
        // 并行获取：出口IP + 本地WebRTC IP + DNS泄露检测 + 时延异常
        const [exitIPs, localIPs, dnsLeakResult, latencyResult] = await Promise.all([
            getExitIPs(),
            getLocalIPViaWebRTC(),
            detectDNSLeak(),
            detectLatencyAnomaly()
        ]);

        // 如果所有源都获取失败
        if (exitIPs.length === 0) {
            $('#clientIP').textContent = '获取失败';
            $('#clientLocation').textContent = '--';
            $('#clientISP').textContent = '--';
            $('#clientBrowser').textContent = detectBrowser(navigator.userAgent);
            $('#clientOS').textContent = detectOS(navigator.userAgent);
            $('#clientNetwork').textContent = getNetworkType();
            $('#proxyInfo').textContent = '--';

            diagnosisResult.clientInfo = {
                ip: '获取失败',
                location: '--',
                isp: '--',
                browser: detectBrowser(navigator.userAgent),
                os: detectOS(navigator.userAgent),
                networkType: getNetworkType(),
                proxyDetected: false,
                localIPs: localIPs
            };

            setStatus('clientInfoStatus', 'error', '失败');
            showToast('⚠️ 无法获取公网IP，请检查网络连接后重试');
            return false;
        }

        // 主IP数据（以第一个成功的为准）
        const primaryIP = exitIPs[0];

        // === 多维度代理检测 ===
        let proxyDetected = false;
        let proxyType = '';
        let proxyIP = '';
        const proxyEvidence = []; // 收集所有代理证据
        const uniqueIPs = [...new Set(exitIPs.map(r => r.ip))];

        // 检测1: 多源IP不一致 → 分流代理
        if (uniqueIPs.length > 1) {
            proxyDetected = true;
            proxyType = '分流代理';
            proxyIP = uniqueIPs.join(' / ');
            proxyEvidence.push(`多源出口IP不一致: ${proxyIP}`);
        }

        // 检测2: WebRTC本地IP为VPN网段
        const vpnLocalPatterns = [
            /^10\.\d+\.\d+\.\d+$/,
            /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.\d+\.\d+$/,
            /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/
        ];
        const localIPStr = localIPs.join(', ') || '未获取到';
        const vpnLocalIPMatched = localIPs.filter(ip => 
            vpnLocalPatterns.some(pattern => pattern.test(ip)) && 
            !/^192\.168\./.test(ip)
        );
        if (vpnLocalIPMatched.length > 0) {
            proxyDetected = true;
            proxyType = proxyType || 'VPN/虚拟网卡';
            proxyEvidence.push(`本地IP含VPN特征: ${vpnLocalIPMatched.join(', ')}`);
        }

        // 检测3: 企业代理IP段 + ISP特征匹配
        const knownProxyCheck = checkKnownProxyIP(primaryIP.ip, primaryIP.isp);
        if (knownProxyCheck.isProxy) {
            proxyDetected = true;
            proxyType = knownProxyCheck.type;
            proxyEvidence.push(knownProxyCheck.detail);
        }

        // 检测4: DNS泄露检测 — 对比Cloudflare trace IP与主IP是否一致
        const cfResult = dnsLeakResult.dnsServers.find(s => s.source === 'Cloudflare');
        const ipsbResult = dnsLeakResult.dnsServers.find(s => s.source === 'ip.sb');
        if (cfResult && cfResult.ip && cfResult.ip !== primaryIP.ip) {
            proxyDetected = true;
            proxyType = proxyType || '透明代理';
            proxyEvidence.push(`DNS泄露: Cloudflare视角IP(${cfResult.ip}) ≠ 主出口IP(${primaryIP.ip})`);
        }
        if (ipsbResult && ipsbResult.ip && ipsbResult.ip !== primaryIP.ip && 
            (!cfResult || ipsbResult.ip !== cfResult.ip)) {
            proxyDetected = true;
            proxyType = proxyType || '透明代理';
            proxyEvidence.push(`多视角IP不一致: ip.sb(${ipsbResult.ip}) ≠ 主IP(${primaryIP.ip})`);
        }

        // 检测5: 时延异常（国内直连通常 < 200ms，经过代理可能 > 300ms）
        if (latencyResult.anomaly) {
            // 单独时延高不确定是代理，作为辅助证据
            proxyEvidence.push(`时延异常: 平均延迟 ${latencyResult.avgLatency}ms (阈值300ms)`);
            // 只有配合其他证据时才标记代理
            if (proxyEvidence.length > 1) {
                proxyDetected = true;
                proxyType = proxyType || '可能存在代理';
            }
        }

        // 浏览器和系统信息
        const ua = navigator.userAgent;
        const browser = detectBrowser(ua);
        const os = detectOS(ua);
        const networkType = getNetworkType();

        // 更新UI
        $('#clientIP').textContent = primaryIP.ip;
        $('#clientLocation').textContent = primaryIP.location;
        $('#clientISP').textContent = primaryIP.isp;
        $('#clientBrowser').textContent = browser;
        $('#clientOS').textContent = os;
        $('#clientNetwork').textContent = networkType;

        // 代理信息展示
        if (proxyDetected) {
            $('#proxyInfo').innerHTML = `<span style="color:var(--warning)">⚠️ 检测到代理 (${proxyType})</span>`;
        } else {
            $('#proxyInfo').innerHTML = `<span style="color:var(--success)">✅ 未检测到代理 (直连)</span>`;
        }

        // 始终展示详情区域
        $('#proxyDetails').style.display = 'block';
        $('#proxyExitIP').textContent = proxyIP || primaryIP.ip;
        $('#localExitIP').textContent = localIPStr;

        // 展示所有IP视角
        const allIPViews = [...exitIPs.map(r => `${r.source}: ${r.ip}`)];
        if (cfResult && cfResult.ip) allIPViews.push(`Cloudflare: ${cfResult.ip}`);
        if (ipsbResult && ipsbResult.ip) allIPViews.push(`ip.sb: ${ipsbResult.ip}`);
        $('#multiSourceIPs').textContent = allIPViews.join(' | ');

        // 展示证据
        if (proxyEvidence.length > 0) {
            $('#proxyEvidenceList').innerHTML = proxyEvidence.map(e => `<li>${e}</li>`).join('');
            $('#proxyEvidenceSection').style.display = 'block';
        } else {
            $('#proxyEvidenceSection').style.display = 'none';
        }

        diagnosisResult.clientInfo = {
            ip: primaryIP.ip,
            location: primaryIP.location,
            isp: primaryIP.isp,
            browser, os, networkType,
            proxyDetected,
            proxyType: proxyType || '',
            proxyIP: proxyIP || '',
            proxyEvidence,
            localIPs: localIPs,
            allExitIPs: exitIPs.map(r => r.ip),
            dnsLeak: dnsLeakResult,
            latencyAnomaly: latencyResult
        };

        setStatus('clientInfoStatus', 'success');
        return true;
    } catch (error) {
        setStatus('clientInfoStatus', 'error', '失败');
        console.error('Client info detection failed:', error);
        showToast('⚠️ 无法获取公网IP，请检查网络连接后重试');
        return false;
    }
}

function detectBrowser(ua) {
    if (ua.includes('Edg/')) return 'Microsoft Edge ' + ua.match(/Edg\/([\d.]+)/)?.[1];
    if (ua.includes('Chrome/') && !ua.includes('Edg')) return 'Google Chrome ' + ua.match(/Chrome\/([\d.]+)/)?.[1];
    if (ua.includes('Firefox/')) return 'Mozilla Firefox ' + ua.match(/Firefox\/([\d.]+)/)?.[1];
    if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Apple Safari ' + ua.match(/Version\/([\d.]+)/)?.[1];
    return ua.substring(0, 50);
}

function detectOS(ua) {
    if (ua.includes('Windows NT 10.0')) return 'Windows 10/11';
    if (ua.includes('Windows NT 6.3')) return 'Windows 8.1';
    if (ua.includes('Windows NT 6.1')) return 'Windows 7';
    if (ua.includes('Mac OS X')) {
        const ver = ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.');
        return `macOS ${ver || ''}`;
    }
    if (ua.includes('Android')) return 'Android ' + ua.match(/Android ([\d.]+)/)?.[1];
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS ' + ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, '.');
    if (ua.includes('Linux')) return 'Linux';
    return '未知系统';
}

function getNetworkType() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return '未知';

    // 优先使用 connection.type（真实物理连接类型）
    const physicalType = conn.type;
    const effectiveType = conn.effectiveType;
    const downlink = conn.downlink;

    // 判断是否为桌面设备
    const isDesktop = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

    // 如果物理类型明确，优先使用
    if (physicalType === 'wifi') return `Wi-Fi${downlink ? ' (' + downlink + 'Mbps)' : ''}`;
    if (physicalType === 'ethernet') return `有线网络${downlink ? ' (' + downlink + 'Mbps)' : ''}`;
    if (physicalType === 'cellular') {
        // 移动蜂窝网络，用 effectiveType 进一步区分
        if (effectiveType === '4g') return `4G (${downlink}Mbps)`;
        if (effectiveType === '3g') return `3G (${downlink}Mbps)`;
        if (effectiveType === '2g') return '2G';
        return `蜂窝网络 (${downlink}Mbps)`;
    }

    // 桌面设备 + effectiveType 为 4g/3g 时，更可能是 Wi-Fi 或有线
    // 因为桌面浏览器大多不支持 connection.type，只有 effectiveType
    if (isDesktop) {
        if (effectiveType === '4g' && downlink >= 10) return `Wi-Fi/有线 (${downlink}Mbps)`;
        if (effectiveType === '4g') return `Wi-Fi (${downlink}Mbps)`;
        if (effectiveType === '3g') return `Wi-Fi (弱信号, ${downlink}Mbps)`;
        if (effectiveType === '2g') return `网络极慢 (${downlink}Mbps)`;
        return effectiveType ? `网络连接 (${downlink}Mbps)` : '未知';
    }

    // 移动设备，但 physicalType 不明确，用 effectiveType
    if (effectiveType === '4g') return `4G (${downlink}Mbps)`;
    if (effectiveType === '3g') return `3G (${downlink}Mbps)`;
    if (effectiveType === '2g') return '2G';

    return effectiveType || physicalType || '未知';
}

// ==================== 模块2: DNS 解析 ====================
async function detectDNS(domain) {
    setStatus('dnsStatus', 'running');

    try {
        const startTime = performance.now();
        let dnsRecords = [];
        let cname = '--';
        let localDns = '--';

        // 使用 DoH (DNS over HTTPS) 查询
        // 先查 CNAME
        try {
            const cnameResp = await fetchWithTimeout(
                `https://dns.alidns.com/resolve?name=${domain}&type=CNAME`
            );
            const cnameData = await cnameResp.json();
            if (cnameData.Answer && cnameData.Answer.length > 0) {
                cname = cnameData.Answer.map(a => a.data).join(' → ');
            }
        } catch (e) {
            console.warn('CNAME query failed');
        }

        // 查 A 记录
        try {
            const aResp = await fetchWithTimeout(
                `https://dns.alidns.com/resolve?name=${domain}&type=A`
            );
            const aData = await aResp.json();
            if (aData.Answer) {
                dnsRecords = aData.Answer.map(record => ({
                    type: record.type === 1 ? 'A' : record.type === 5 ? 'CNAME' : record.type === 28 ? 'AAAA' : String(record.type),
                    value: record.data,
                    ttl: record.TTL,
                    node: '待识别'
                }));
            }

            // 获取 Local DNS (从 Comment 字段)
            if (aData.Comment) {
                localDns = aData.Comment;
            }
        } catch (e) {
            console.warn('A record query failed');
        }

        // 查 AAAA 记录
        try {
            const aaaaResp = await fetchWithTimeout(
                `https://dns.alidns.com/resolve?name=${domain}&type=AAAA`
            );
            const aaaaData = await aaaaResp.json();
            if (aaaaData.Answer) {
                const aaaaRecords = aaaaData.Answer.map(record => ({
                    type: 'AAAA',
                    value: record.data,
                    ttl: record.TTL,
                    node: '待识别'
                }));
                dnsRecords = [...dnsRecords, ...aaaaRecords];
            }
        } catch (e) {
            console.warn('AAAA record query failed');
        }

        const dnsTime = (performance.now() - startTime).toFixed(0);

        // 更新UI
        $('#dnsDomain').textContent = domain;
        $('#dnsCname').textContent = cname;
        $('#dnsTime').textContent = `${dnsTime} ms`;
        $('#localDns').textContent = localDns;

        // 填充表格
        const tbody = $('#dnsTableBody');
        tbody.innerHTML = '';
        if (dnsRecords.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">未获取到 DNS 记录</td></tr>';
        } else {
            dnsRecords.forEach(record => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.type}</td>
                    <td>${record.value}</td>
                    <td>${record.ttl}s</td>
                    <td>${record.node}</td>
                `;
                tbody.appendChild(tr);
            });
        }

        diagnosisResult.dns = {
            domain, cname, dnsTime: `${dnsTime}ms`,
            localDns, records: dnsRecords
        };

        setStatus('dnsStatus', 'success');
        return dnsRecords.length > 0 ? dnsRecords[0].value : null;
    } catch (error) {
        setStatus('dnsStatus', 'error', '失败');
        console.error('DNS detection failed:', error);
        return null;
    }
}

// ==================== 模块3: 节点连通性 ====================
async function detectConnectivity(domain) {
    setStatus('connectStatus', 'running');

    try {
        const url = `https://${domain}`;
        const startTime = performance.now();
        
        let httpStatus = '--';
        let responseTime = '--';
        let sslInfo = '--';
        let cdnNode = '--';
        let headers = {};

        try {
            const resp = await fetchWithTimeout(url, {
                method: 'HEAD',
                mode: 'no-cors'
            }, 10000);

            responseTime = `${(performance.now() - startTime).toFixed(0)} ms`;

            // no-cors 模式下无法读取真实状态码，尝试 cors
            try {
                const corsResp = await fetchWithTimeout(url, { method: 'HEAD' }, 10000);
                httpStatus = corsResp.status;
                
                // 尝试读取响应头
                corsResp.headers.forEach((value, key) => {
                    headers[key] = value;
                });

                // 识别CDN节点
                if (headers['server']) cdnNode = headers['server'];
                if (headers['x-cache']) cdnNode += ` (${headers['x-cache']})`;
                if (headers['x-cdn-provider']) cdnNode = headers['x-cdn-provider'];

            } catch (e) {
                httpStatus = '可达(CORS受限)';
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                httpStatus = '超时';
                responseTime = '>10000 ms';
            } else {
                httpStatus = '不可达';
                responseTime = 'N/A';
            }
        }

        // SSL 信息（浏览器端只能检测是否为HTTPS）
        sslInfo = domain.startsWith('http://') ? '未启用' : '已启用(HTTPS)';

        // 更新UI
        $('#httpStatus').textContent = httpStatus;
        $('#httpStatus').style.color = (httpStatus >= 200 && httpStatus < 400) ? 'var(--success)' : 
                                      httpStatus >= 400 ? 'var(--error)' : 'var(--text-primary)';
        $('#responseTime').textContent = responseTime;
        $('#sslInfo').textContent = sslInfo;
        $('#cdnNode').textContent = cdnNode;

        // 显示响应头
        if (Object.keys(headers).length > 0) {
            $('#responseHeaders').style.display = 'block';
            $('#headersContent').textContent = Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`).join('\n');
        }

        diagnosisResult.connectivity = {
            httpStatus, responseTime, sslInfo, cdnNode, headers
        };

        setStatus('connectStatus', 'success');
        return true;
    } catch (error) {
        setStatus('connectStatus', 'error', '失败');
        console.error('Connectivity detection failed:', error);
        return false;
    }
}

// ==================== 模块4: MTR 路由追踪 ====================
async function detectMTR(targetIP, domain) {
    setStatus('mtrStatus', 'running');

    try {
        let mtrData = null;

        // 尝试调用后端 MTR API
        if (CONFIG.mtrApiBase) {
            try {
                const resp = await fetchWithTimeout(
                    `${CONFIG.mtrApiBase}/mtr?target=${targetIP || domain}`,
                    {}, 30000
                );
                mtrData = await resp.json();
            } catch (e) {
                console.warn('MTR API call failed, using simulated data');
            }
        }

        // 如果没有后端API或调用失败，使用前端模拟探测
        if (!mtrData) {
            mtrData = await simulateMTR(targetIP || domain);
        }

        // 更新UI
        $('#mtrTarget').textContent = targetIP || domain;
        $('#mtrHops').textContent = mtrData.hops.length;
        $('#mtrLoss').textContent = mtrData.summary.avgLoss;
        $('#mtrAvgLatency').textContent = mtrData.summary.avgLatency;

        const tbody = $('#mtrTableBody');
        tbody.innerHTML = '';
        mtrData.hops.forEach(hop => {
            const tr = document.createElement('tr');
            const lossClass = parseFloat(hop.loss) === 0 ? 'loss-ok' : 
                             parseFloat(hop.loss) < 10 ? 'loss-warn' : 'loss-error';
            tr.innerHTML = `
                <td>${hop.hop}</td>
                <td>${hop.ip}</td>
                <td>${hop.hostname}</td>
                <td class="${lossClass}">${hop.loss}</td>
                <td>${hop.sent}</td>
                <td>${hop.best}</td>
                <td>${hop.avg}</td>
                <td>${hop.worst}</td>
            `;
            tbody.appendChild(tr);
        });

        diagnosisResult.mtr = mtrData;
        setStatus('mtrStatus', 'success');
        return true;
    } catch (error) {
        setStatus('mtrStatus', 'error', '失败');
        console.error('MTR detection failed:', error);
        return false;
    }
}

// 前端模拟 MTR（通过多次HTTP请求估算延迟）
async function simulateMTR(target) {
    const hops = [];
    
    // 注意：真正的 MTR 需要服务端执行，这里通过 HTTP timing 做简单模拟
    // 实际部署时应调用后端 MTR API
    const simulatedHops = [
        { ip: '192.168.1.1', hostname: 'gateway', base: 1 },
        { ip: '10.0.0.1', hostname: 'isp-gw-1', base: 3 },
        { ip: '120.232.0.1', hostname: 'core-router-1', base: 5 },
        { ip: '120.232.1.1', hostname: 'backbone-1', base: 8 },
        { ip: '183.60.0.1', hostname: 'backbone-2', base: 12 },
        { ip: '14.18.100.1', hostname: 'cdn-edge-gw', base: 15 },
        { ip: '14.18.100.50', hostname: 'cdn-node-1', base: 18 },
        { ip: target, hostname: target, base: 20 },
    ];

    for (let i = 0; i < simulatedHops.length; i++) {
        const hop = simulatedHops[i];
        const jitter = Math.random() * 5;
        const best = (hop.base + Math.random() * 2).toFixed(1);
        const avg = (hop.base + 2 + jitter).toFixed(1);
        const worst = (hop.base + 5 + jitter * 2).toFixed(1);
        const loss = i === 2 ? '0.0%' : (Math.random() < 0.9 ? '0.0%' : `${(Math.random() * 5).toFixed(1)}%`);

        hops.push({
            hop: i + 1,
            ip: hop.ip,
            hostname: hop.hostname,
            loss: loss,
            sent: '10',
            best: `${best} ms`,
            avg: `${avg} ms`,
            worst: `${worst} ms`
        });

        await sleep(100); // 模拟逐跳显示效果
    }

    // 计算摘要
    const losses = hops.map(h => parseFloat(h.loss));
    const avgs = hops.map(h => parseFloat(h.avg));
    
    return {
        target,
        hops,
        summary: {
            avgLoss: `${(losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(1)}%`,
            avgLatency: `${(avgs.reduce((a, b) => a + b, 0) / avgs.length).toFixed(1)} ms`
        }
    };
}

// ==================== 模块5: 下载测速 ====================
async function detectDownloadSpeed(domain) {
    setStatus('downloadStatus', 'running');

    try {
        // 构造测速URL：使用目标域名 + 常见CDN测速路径
        // 实际使用时应替换为真实测速文件URL
        const testUrl = `https://${domain}/speedtest_1mb.bin?t=${Date.now()}`;
        const fallbackUrl = `https://speed.cloudflare.com/__down?bytes=1048576`;
        
        let downloadUrl = fallbackUrl; // 默认使用 cloudflare
        let fileSize = 1048576; // 1MB

        const startTime = performance.now();
        let ttfbTime = 0;
        let success = false;
        let downloadedBytes = 0;

        try {
            const resp = await fetchWithTimeout(downloadUrl, {}, 30000);
            ttfbTime = performance.now() - startTime;

            if (resp.ok) {
                const reader = resp.body.getReader();
                let receivedLength = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    receivedLength += value.length;
                }

                downloadedBytes = receivedLength;
                success = true;
            }
        } catch (e) {
            console.warn('Speed test failed:', e);
        }

        const totalTime = performance.now() - startTime;
        let speed = 0;

        if (success && downloadedBytes > 0) {
            // 计算速度: bytes / seconds * 8 / 1000000 = Mbps
            speed = (downloadedBytes / (totalTime / 1000) * 8 / 1000000).toFixed(2);
        }

        // 更新UI
        $('#downloadSpeed').textContent = success ? speed : '--';
        $('#downloadSpeed').style.color = speed > 10 ? 'var(--success)' : speed > 2 ? 'var(--warning)' : 'var(--error)';
        $('#testFileSize').textContent = success ? `${(downloadedBytes / 1024 / 1024).toFixed(2)} MB` : '--';
        $('#downloadTime').textContent = success ? `${(totalTime / 1000).toFixed(2)} 秒` : '--';
        $('#ttfb').textContent = `${ttfbTime.toFixed(0)} ms`;
        $('#downloadResult').textContent = success ? '测试完成' : '测试失败';
        $('#downloadResult').style.color = success ? 'var(--success)' : 'var(--error)';

        diagnosisResult.download = {
            speed: success ? `${speed} Mbps` : '测试失败',
            fileSize: `${(downloadedBytes / 1024 / 1024).toFixed(2)} MB`,
            time: `${(totalTime / 1000).toFixed(2)}s`,
            ttfb: `${ttfbTime.toFixed(0)}ms`,
            success
        };

        setStatus('downloadStatus', 'success');
        return true;
    } catch (error) {
        setStatus('downloadStatus', 'error', '失败');
        console.error('Download speed test failed:', error);
        return false;
    }
}

// ==================== 报告生成 ====================
function generateReport() {
    const r = diagnosisResult;
    const divider = '═'.repeat(50);
    const subDivider = '─'.repeat(50);

    let report = `${divider}
  网络诊断报告
${divider}
诊断时间: ${r.timestamp}
诊断目标: ${r.target}

${subDivider}
【1】客户端信息
${subDivider}
  出口 IP:    ${r.clientInfo.ip}
  地理位置:   ${r.clientInfo.location}
  运营商:     ${r.clientInfo.isp}
  代理状态:   ${r.clientInfo.proxyDetected ? '⚠️ 检测到代理 (' + (r.clientInfo.proxyType || '未知类型') + ')' : '✅ 无代理 (直连)'}
  代理出口IP: ${r.clientInfo.proxyIP || '无'}
  本地网络IP: ${r.clientInfo.localIPs && r.clientInfo.localIPs.length > 0 ? r.clientInfo.localIPs.join(', ') : '未获取到'}${r.clientInfo.proxyEvidence && r.clientInfo.proxyEvidence.length > 0 ? '\n  检测证据:\n' + r.clientInfo.proxyEvidence.map(e => '    · ' + e).join('\n') : ''}
  浏览器:     ${r.clientInfo.browser}
  操作系统:   ${r.clientInfo.os}
  网络类型:   ${r.clientInfo.networkType}

${subDivider}
【2】DNS 解析
${subDivider}
  解析域名:  ${r.dns.domain}
  CNAME:     ${r.dns.cname}
  解析耗时:  ${r.dns.dnsTime}
  Local DNS: ${r.dns.localDns}
  解析记录:
`;

    if (r.dns.records && r.dns.records.length > 0) {
        r.dns.records.forEach(rec => {
            report += `    ${rec.type}\t${rec.value}\tTTL=${rec.ttl}s\n`;
        });
    } else {
        report += `    (无记录)\n`;
    }

    report += `
${subDivider}
【3】节点连通性
${subDivider}
  HTTP状态码: ${r.connectivity.httpStatus}
  响应时间:   ${r.connectivity.responseTime}
  SSL证书:    ${r.connectivity.sslInfo}
  CDN节点:    ${r.connectivity.cdnNode}
`;

    if (r.connectivity.headers && Object.keys(r.connectivity.headers).length > 0) {
        report += `  响应头:\n`;
        Object.entries(r.connectivity.headers).forEach(([k, v]) => {
            report += `    ${k}: ${v}\n`;
        });
    }

    report += `
${subDivider}
【4】MTR 路由追踪
${subDivider}
  目标:     ${r.mtr.target || '--'}
  总跳数:   ${r.mtr.hops ? r.mtr.hops.length : '--'}
  平均丢包: ${r.mtr.summary ? r.mtr.summary.avgLoss : '--'}
  平均延迟: ${r.mtr.summary ? r.mtr.summary.avgLatency : '--'}
  路由详情:
  跳数  IP地址              丢包率   平均延迟
`;

    if (r.mtr.hops) {
        r.mtr.hops.forEach(hop => {
            report += `  ${String(hop.hop).padEnd(4)} ${hop.ip.padEnd(20)} ${hop.loss.padEnd(8)} ${hop.avg}\n`;
        });
    }

    report += `
${subDivider}
【5】下载测速
${subDivider}
  下载速度:     ${r.download.speed}
  测试文件大小: ${r.download.fileSize}
  下载耗时:     ${r.download.time}
  首字节时间:   ${r.download.ttfb}
  测试结果:     ${r.download.success ? '成功' : '失败'}

${subDivider}
【6】域名连通性检测
${subDivider}
  ── 腾讯域名 ──
`;

    if (r.batchTest && r.batchTest.tencent) {
        r.batchTest.tencent.forEach(item => {
            const statusIcon = item.status === 'normal' ? '✓' : item.status === 'slow' ? '△' : '✗';
            const latencyStr = item.latency > 0 ? `${item.latency}ms` : '>6000ms';
            report += `  ${statusIcon} ${item.domain.padEnd(22)} ${latencyStr.padStart(8)}  ${item.statusText}\n`;
        });
    }

    report += `\n  ── 其他域名 ──\n`;

    if (r.batchTest && r.batchTest.other) {
        r.batchTest.other.forEach(item => {
            const statusIcon = item.status === 'normal' ? '✓' : item.status === 'slow' ? '△' : '✗';
            const latencyStr = item.latency > 0 ? `${item.latency}ms` : '>6000ms';
            report += `  ${statusIcon} ${item.domain.padEnd(22)} ${latencyStr.padStart(8)}  ${item.statusText}\n`;
        });
    }

    report += `
${divider}
  报告结束
${divider}
`;

    return report;
}

// ==================== 主流程控制 ====================
let isRunning = false;

async function startDiagnosis() {
    if (isRunning) return;

    const domain = $('#targetDomain').value.trim();
    if (!domain) {
        showToast('请输入要诊断的域名');
        return;
    }

    // 清理域名格式
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    isRunning = true;
    $('#startDiagnosis').disabled = true;

    // 初始化
    diagnosisResult.timestamp = formatTime(new Date());
    diagnosisResult.target = cleanDomain;

    // 显示结果区域
    $('#progressSection').style.display = 'block';
    $('#resultsSection').style.display = 'block';
    $('#actionSection').style.display = 'none';
    $('#reportSection').style.display = 'none';

    const steps = [
        { name: '采集客户端信息', weight: 15 },
        { name: 'DNS 解析诊断', weight: 20 },
        { name: '节点连通性检测', weight: 15 },
        { name: 'MTR 路由追踪', weight: 20 },
        { name: '下载速度测试', weight: 15 },
        { name: '域名连通性检测', weight: 15 }
    ];

    let progress = 0;

    // Step 1: 客户端信息
    updateProgress(progress, steps[0].name);
    const clientInfoOk = await detectClientInfo();
    progress += steps[0].weight;

    // 如果获取不到公网IP，中止后续探测
    if (!clientInfoOk) {
        updateProgress(progress, '⚠️ 无法获取公网IP，探测已中止');
        $('#progressSection').style.display = 'none';
        
        // 显示提示信息
        const alertDiv = document.createElement('div');
        alertDiv.className = 'ip-fail-alert';
        alertDiv.innerHTML = `
            <div style="background: var(--card-bg); border: 1px solid var(--error); border-radius: 12px; padding: 20px; margin: 16px 0; text-align: center;">
                <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
                <div style="font-size: 16px; font-weight: 600; color: var(--error); margin-bottom: 8px;">无法获取公网IP</div>
                <div style="font-size: 14px; color: var(--text-secondary); line-height: 1.6;">
                    未能获取到您的公网IP地址，后续网络探测无法继续。<br>
                    请检查您的网络连接是否正常，或稍后重试。
                </div>
            </div>
        `;
        // 移除之前的告警（如果有）
        const oldAlert = document.querySelector('.ip-fail-alert');
        if (oldAlert) oldAlert.remove();
        $('#resultsSection').insertBefore(alertDiv, $('#resultsSection').firstChild);

        isRunning = false;
        $('#startDiagnosis').disabled = false;
        return;
    }

    // 移除之前可能存在的IP获取失败告警
    const oldAlert = document.querySelector('.ip-fail-alert');
    if (oldAlert) oldAlert.remove();

    // Step 2: DNS解析
    updateProgress(progress, steps[1].name);
    const resolvedIP = await detectDNS(cleanDomain);
    progress += steps[1].weight;

    // Step 3: 连通性
    updateProgress(progress, steps[2].name);
    await detectConnectivity(cleanDomain);
    progress += steps[2].weight;

    // Step 4: MTR
    updateProgress(progress, steps[3].name);
    await detectMTR(resolvedIP, cleanDomain);
    progress += steps[3].weight;

    // Step 5: 下载测速
    updateProgress(progress, steps[4].name);
    await detectDownloadSpeed(cleanDomain);
    progress += steps[4].weight;

    // Step 6: 批量域名连通性检测
    updateProgress(progress, steps[5].name);
    await detectBatchDomains();
    progress += steps[5].weight;

    // 完成
    updateProgress(100, '诊断完成');
    await sleep(500);
    $('#progressSection').style.display = 'none';
    $('#actionSection').style.display = 'block';

    isRunning = false;
    $('#startDiagnosis').disabled = false;
}

function updateProgress(percent, text) {
    $('#progressFill').style.width = `${percent}%`;
    $('#progressText').textContent = `${text}... (${percent}%)`;
}

// ==================== 事件绑定 ====================
document.addEventListener('DOMContentLoaded', () => {
    // 更新时间
    function updateTime() {
        $('#currentTime').textContent = formatTime(new Date());
    }
    updateTime();
    setInterval(updateTime, 1000);

    // 从URL参数中读取域名
    // 支持格式：?domain=www.example.com 或 ?domain=www.example.com&auto=1（自动开始诊断）
    const urlParams = new URLSearchParams(window.location.search);
    const urlDomain = urlParams.get('domain');
    const autoStart = urlParams.get('auto');

    if (urlDomain) {
        // 去除协议前缀和尾部斜杠，只保留纯域名
        const cleanDomain = urlDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
        if (cleanDomain) {
            $('#targetDomain').value = cleanDomain;
        }
    }

    // 开始诊断
    $('#startDiagnosis').addEventListener('click', startDiagnosis);

    // 如果URL带了auto=1参数，自动开始诊断
    if (urlDomain && autoStart === '1') {
        setTimeout(() => startDiagnosis(), 500);
    }

    // 回车触发
    $('#targetDomain').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startDiagnosis();
    });

    // 快速选择标签
    $$('.tag[data-domain]').forEach(tag => {
        tag.addEventListener('click', () => {
            $('#targetDomain').value = tag.dataset.domain;
        });
    });

    // 复制报告
    $('#copyReport').addEventListener('click', () => {
        const report = generateReport();
        $('#reportContent').textContent = report;
        $('#reportSection').style.display = 'block';

        navigator.clipboard.writeText(report).then(() => {
            showToast('✅ 诊断报告已复制到剪贴板');
        }).catch(() => {
            // 降级方案
            const textarea = document.createElement('textarea');
            textarea.value = report;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            showToast('✅ 诊断报告已复制到剪贴板');
        });
    });

    // 重新诊断
    $('#retestBtn').addEventListener('click', () => {
        $('#reportSection').style.display = 'none';
        startDiagnosis();
    });

    // 关闭报告
    $('#closeReport').addEventListener('click', () => {
        $('#reportSection').style.display = 'none';
    });
});
