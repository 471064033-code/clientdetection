/**
 * 客户端网络诊断工具
 * 功能：收集客户端信息、DNS解析、节点连通性、MTR路由追踪、下载测速
 */

// ==================== 配置 ====================
const CONFIG = {
    // 获取客户端IP的公共API源已在 getExitIPs() 中定义（6个源并发，增强可用性）
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
    // MTR 后端 API（已部署，TencentOS 3.2 + mtr-tiny + Node 10 + systemd）
    // 默认走 TCP 80 模式（云内 ICMP 通常被 ACL 限制）
    mtrApiBase: 'http://30.184.62.61.devcloud.woa.com:3089',
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

    // 定义多个IP源，增加成功概率
    const ipSources = [
        // 源1: ip-api.com（注意：免费版仅支持 HTTP，HTTPS页面可能被CORS阻止）
        {
            url: 'http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,as,query',
            parse: async (resp) => {
                const data = await resp.json();
                if (data.status === 'success') {
                    return {
                        source: 'ip-api.com',
                        ip: data.query,
                        location: `${data.country} ${data.regionName} ${data.city}`,
                        isp: data.isp || data.org,
                        as: data.as
                    };
                }
                return null;
            }
        },
        // 源2: ipinfo.io
        {
            url: 'https://ipinfo.io/json',
            parse: async (resp) => {
                const data = await resp.json();
                if (data.ip) {
                    return {
                        source: 'ipinfo.io',
                        ip: data.ip,
                        location: `${data.country || ''} ${data.region || ''} ${data.city || ''}`.trim(),
                        isp: data.org || '',
                        as: ''
                    };
                }
                return null;
            }
        },
        // 源3: ip.sb（支持HTTPS，CORS友好）
        {
            url: 'https://api.ip.sb/jsonip',
            parse: async (resp) => {
                const data = await resp.json();
                if (data.ip) {
                    return { source: 'ip.sb', ip: data.ip, location: '', isp: '', as: '' };
                }
                return null;
            }
        },
        // 源4: Cloudflare trace（返回纯文本，稳定可靠）
        {
            url: 'https://1.1.1.1/cdn-cgi/trace',
            parse: async (resp) => {
                const text = await resp.text();
                const cfData = {};
                text.split('\n').forEach(line => {
                    const [key, value] = line.split('=');
                    if (key && value) cfData[key.trim()] = value.trim();
                });
                if (cfData.ip) {
                    return {
                        source: 'Cloudflare',
                        ip: cfData.ip,
                        location: `${cfData.loc || ''}`,
                        isp: '',
                        as: ''
                    };
                }
                return null;
            }
        },
        // 源5: ipify（简单可靠，支持CORS）
        {
            url: 'https://api.ipify.org?format=json',
            parse: async (resp) => {
                const data = await resp.json();
                if (data.ip) {
                    return { source: 'ipify', ip: data.ip, location: '', isp: '', as: '' };
                }
                return null;
            }
        },
        // 源6: seeip.org（CORS友好）
        {
            url: 'https://ip.seeip.org/jsonip',
            parse: async (resp) => {
                const data = await resp.json();
                if (data.ip) {
                    return { source: 'seeip.org', ip: data.ip, location: '', isp: '', as: '' };
                }
                return null;
            }
        }
    ];

    // 并发请求所有源，取成功的
    const settled = await Promise.allSettled(
        ipSources.map(async (src) => {
            try {
                const resp = await fetchWithTimeout(src.url, {}, 8000);
                if (!resp.ok) return null;
                return await src.parse(resp);
            } catch (e) {
                console.warn(`IP source ${src.source || src.url} failed:`, e.message);
                return null;
            }
        })
    );

    for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
            results.push(result.value);
        }
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
            $('#clientIP').style.color = 'var(--error)';
            $('#clientLocation').textContent = '--';
            $('#clientISP').textContent = '--';
            $('#clientBrowser').textContent = detectBrowser(navigator.userAgent);
            $('#clientOS').textContent = detectOS(navigator.userAgent);
            $('#clientNetwork').textContent = getNetworkType();
            $('#proxyInfo').textContent = '无法检测（未获取到公网IP）';
            $('#primaryIPv4').textContent = '--';
            $('#primaryIPv6').textContent = '--';
            $('#ipConsistencyNote').textContent = '未获取到可用公网 IP';

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

            setStatus('clientInfoStatus', 'error', 'IP获取失败');
            showToast('⚠️ 无法获取公网IP，但其他诊断项仍可继续');
            // 不再 return false，允许后续诊断继续
            return true;
        }

        // 主IP数据（以第一个成功的为准）
        const primaryIP = exitIPs[0];

        // 工具：判断 IP 是否是 IPv6（含 ":"）
        const isIPv6 = (ip) => typeof ip === 'string' && ip.indexOf(':') > -1;
        // 工具：判断两个 IP 是否"实质相同"——只对比同协议族
        // IPv4 和 IPv6 之间不可比较（同一终端双栈下本就有两个地址，不算代理）
        const ipsEquivalent = (a, b) => {
            if (!a || !b) return true; // 缺数据时不判异常
            if (isIPv6(a) !== isIPv6(b)) return true; // 跨协议族 → 视为一致
            return a === b;
        };

        // === 多维度代理检测 ===
        let proxyDetected = false;
        let proxyType = '';
        let proxyIP = '';
        const proxyEvidence = []; // 收集所有代理证据
        // 仅在同协议族内比较：分别看 IPv4 集合 / IPv6 集合 是否各自一致
        const ipv4Set = [...new Set(exitIPs.map(r => r.ip).filter(ip => !isIPv6(ip)))];
        const ipv6Set = [...new Set(exitIPs.map(r => r.ip).filter(ip => isIPv6(ip)))];
        const uniqueIPs = [...new Set(exitIPs.map(r => r.ip))];

        const primaryIPv4 = ipv4Set[0] || '--';
        const primaryIPv6 = ipv6Set[0] || '--';
        let ipConsistencyNote = '多源 IP 一致';
        if (ipv4Set.length > 1 || ipv6Set.length > 1) {
            const family = ipv4Set.length > 1 ? 'IPv4' : 'IPv6';
            ipConsistencyNote = `${family} 多源结果不一致（可能由分流/运营商CGNAT导致）`;
        } else if (ipv4Set.length === 1 && ipv6Set.length === 1) {
            ipConsistencyNote = '双栈网络：不同网站可能分别显示 IPv4 或 IPv6（正常）';
        }

        // 检测1: 同协议族内多源IP不一致 → 分流代理
        if (ipv4Set.length > 1 || ipv6Set.length > 1) {
            proxyDetected = true;
            proxyType = '分流代理';
            const conflict = ipv4Set.length > 1 ? ipv4Set : ipv6Set;
            proxyIP = conflict.join(' / ');
            proxyEvidence.push(`多源出口IP不一致: ${proxyIP}`);
        } else if (ipv4Set.length === 1 && ipv6Set.length === 1) {
            // 双栈场景，正常，不算证据
            proxyEvidence.push(`IPv4/IPv6 双栈：${ipv4Set[0]} + ${ipv6Set[0]}（正常，非代理）`);
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

        // 检测4: DNS泄露检测 — 对比Cloudflare trace IP与主IP是否一致（仅同协议族比较）
        const cfResult = dnsLeakResult.dnsServers.find(s => s.source === 'Cloudflare');
        const ipsbResult = dnsLeakResult.dnsServers.find(s => s.source === 'ip.sb');
        if (cfResult && cfResult.ip && !ipsEquivalent(cfResult.ip, primaryIP.ip)) {
            proxyDetected = true;
            proxyType = proxyType || '透明代理';
            proxyEvidence.push(`DNS泄露: Cloudflare视角IP(${cfResult.ip}) ≠ 主出口IP(${primaryIP.ip})`);
        }
        if (ipsbResult && ipsbResult.ip && !ipsEquivalent(ipsbResult.ip, primaryIP.ip) &&
            (!cfResult || !ipsEquivalent(ipsbResult.ip, cfResult.ip))) {
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
        $('#primaryIPv4').textContent = primaryIPv4;
        $('#primaryIPv6').textContent = primaryIPv6;
        $('#ipConsistencyNote').textContent = ipConsistencyNote;

        // 展示所有IP视角
        const allIPViews = [...exitIPs.map(r => `${r.source}: ${r.ip}`)];
        if (cfResult && cfResult.ip) allIPViews.push(`Cloudflare: ${cfResult.ip}`);
        if (ipsbResult && ipsbResult.ip) allIPViews.push(`ip.sb: ${ipsbResult.ip}`);
        $('#multiSourceIPs').textContent = allIPViews.join(' | ');

        // 展示证据：区分"实质证据"和"信息说明"
        const realEvidence = proxyEvidence.filter(e => !e.includes('双栈：'));
        const stackInfo = proxyEvidence.filter(e => e.includes('双栈：'));
        const evidenceHtml = [
            ...realEvidence.map(e => `<li>${e}</li>`),
            ...stackInfo.map(e => `<li style="color:#8b949e; list-style:none; margin-left:-20px;">ⓘ ${e}</li>`)
        ].join('');
        if (evidenceHtml) {
            $('#proxyEvidenceList').innerHTML = evidenceHtml;
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
            primaryIPv4,
            primaryIPv6,
            ipConsistencyNote,
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
                // CORS 受限：no-cors 请求成功（说明能连上目标），但浏览器同源策略禁止 JS 读取真实状态码和响应头
                // 这不是网络问题，是浏览器安全机制——能正常访问，只是看不到详细信息
                httpStatus = '可连通';
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
        // 数字状态码用红绿标色；"可连通" 视为成功（绿色）
        if (typeof httpStatus === 'number') {
            $('#httpStatus').style.color = (httpStatus >= 200 && httpStatus < 400) ? 'var(--success)' :
                                          httpStatus >= 400 ? 'var(--error)' : 'var(--text-primary)';
        } else if (httpStatus.indexOf('可连通') === 0) {
            $('#httpStatus').style.color = 'var(--success)';
        } else if (httpStatus === '超时' || httpStatus === '不可达') {
            $('#httpStatus').style.color = 'var(--error)';
        } else {
            $('#httpStatus').style.color = 'var(--text-primary)';
        }
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
        const target = targetIP || domain;

        // 尝试调用后端 MTR API
        if (CONFIG.mtrApiBase) {
            try {
                const resp = await fetchWithTimeout(
                    `${CONFIG.mtrApiBase}/mtr?target=${encodeURIComponent(target)}&protocol=auto&port=80`,
                    {}, 60000
                );
                if (resp.ok) {
                    mtrData = await resp.json();
                    if (mtrData.error) {
                        console.warn('MTR API returned error:', mtrData.error);
                        mtrData = null;
                    } else {
                        mtrData.mode = 'server';
                        mtrData.source = 'mtr-api';
                    }
                }
            } catch (e) {
                console.warn('MTR API call failed:', e.message);
            }
        }

        // 没有后端 API 时，仍跑浏览器端有限探测作为占位（标注清楚）
        if (!mtrData) {
            mtrData = await browserTraceroute(target);
        }

        // 存储到服务端视角
        mtrState.server = mtrData;
        // 默认展示服务端视角
        renderMtrByMode('server');
        analyzeMtrComparison();

        diagnosisResult.mtr = mtrData;
        setStatus('mtrStatus', 'success');
        return true;
    } catch (error) {
        setStatus('mtrStatus', 'error', '失败');
        console.error('MTR detection failed:', error);
        return false;
    }
}

// 浏览器端真实探测：通过多次 HTTP 请求测量到目标的 RTT
// 这不是传统 traceroute，但能提供：
// 1. 到目标的真实延迟（多次采样取 best/avg/worst）
// 2. 丢包率（请求失败比例）
// 3. DNS 解析路径上的 IP 信息
async function browserTraceroute(target) {
    const hops = [];
    const PROBE_COUNT = 10;
    
    // 判断 target 是否为域名（可以发 HTTP 请求）
    const isDomain = !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target);
    
    // 尝试通过 DNS 获取中间信息
    let resolvedIPs = [];
    if (isDomain) {
        try {
            const dnsResp = await fetchWithTimeout(
                `https://dns.alidns.com/resolve?name=${target}&type=A`,
                { headers: { 'Accept': 'application/dns-json' } }, 5000
            );
            const dnsData = await dnsResp.json();
            if (dnsData.Answer) {
                resolvedIPs = dnsData.Answer
                    .filter(a => a.type === 1 || a.type === 5)
                    .map(a => ({ type: a.type === 5 ? 'CNAME' : 'A', value: a.data }));
            }
        } catch (e) { /* ignore */ }
    }

    // 获取本地网关信息（通过 WebRTC 已获取的 localIP）
    const localGateway = diagnosisResult.clientInfo && diagnosisResult.clientInfo.localIPs 
        ? diagnosisResult.clientInfo.localIPs[0] : null;
    
    if (localGateway) {
        // 跳 1：本地网关（估算，延迟通常 < 1ms）
        hops.push({
            hop: 1,
            ip: localGateway.replace(/\.\d+$/, '.1'),
            hostname: 'local-gateway (推断)',
            loss: '0.0%',
            sent: '-',
            best: '< 1 ms',
            avg: '< 1 ms',
            worst: '< 1 ms'
        });
    }

    // CNAME 链路展示（如果有）
    const cnameHops = resolvedIPs.filter(r => r.type === 'CNAME');
    cnameHops.forEach((cname, idx) => {
        hops.push({
            hop: hops.length + 1,
            ip: cname.value,
            hostname: `CNAME → ${cname.value}`,
            loss: '-',
            sent: '-',
            best: '-',
            avg: '-',
            worst: '-'
        });
    });

    // 最终跳：通过多次 HTTP 请求真实测量 RTT 和丢包
    const targetUrl = isDomain ? `https://${target}` : `http://${target}`;
    const latencies = [];
    let failCount = 0;

    for (let i = 0; i < PROBE_COUNT; i++) {
        try {
            const start = performance.now();
            await fetch(targetUrl, {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-store'
            });
            const elapsed = performance.now() - start;
            latencies.push(elapsed);
        } catch (e) {
            failCount++;
        }
        // 间隔 200ms 避免浏览器限流
        if (i < PROBE_COUNT - 1) await sleep(200);
    }

    const lossRate = ((failCount / PROBE_COUNT) * 100).toFixed(1);
    
    if (latencies.length > 0) {
        const best = Math.min(...latencies).toFixed(1);
        const worst = Math.max(...latencies).toFixed(1);
        const avg = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);
        const finalIP = resolvedIPs.find(r => r.type === 'A')?.value || target;

        hops.push({
            hop: hops.length + 1,
            ip: finalIP,
            hostname: isDomain ? target : finalIP,
            loss: `${lossRate}%`,
            sent: String(PROBE_COUNT),
            best: `${best} ms`,
            avg: `${avg} ms`,
            worst: `${worst} ms`
        });
    } else {
        // 全部失败
        const finalIP = resolvedIPs.find(r => r.type === 'A')?.value || target;
        hops.push({
            hop: hops.length + 1,
            ip: finalIP,
            hostname: isDomain ? target : finalIP,
            loss: '100.0%',
            sent: String(PROBE_COUNT),
            best: '* ms',
            avg: '* ms',
            worst: '* ms'
        });
    }

    // 摘要
    const validLatencies = latencies.length > 0 ? latencies : [0];
    const avgLatency = (validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length).toFixed(1);

    return {
        target,
        mode: 'browser', // 标记为浏览器端探测
        hops,
        summary: {
            avgLoss: `${lossRate}%`,
            avgLatency: `${avgLatency} ms`,
            totalHops: hops.length
        },
        note: '浏览器安全限制，仅能探测最终跳。完整路由路径需部署 MTR API 后端服务。'
    };
}

// ==================== 双拨测：状态存储 + 视角切换 ====================
const mtrState = {
    server: null,   // 服务端 mtr-api 拨测结果
    client: null,   // 客户端粘贴解析结果
    currentMode: 'server'  // 当前展示的视角：server / client / compare
};

// 渲染指定视角到上方表格
function renderMtrByMode(mode) {
    mtrState.currentMode = mode;
    const data = mode === 'server' ? mtrState.server : mtrState.client;
    const label = mode === 'server' ? '服务端视角' : '客户端视角';

    $('#mtrTableLabel').textContent = label;
    $('#mtrCurrentMode').textContent = mode === 'server' ? '服务端' : '客户端';

    const tbody = $('#mtrTableBody');
    tbody.innerHTML = '';

    if (!data) {
        $('#mtrTarget').textContent = '--';
        $('#mtrHops').textContent = '--';
        $('#mtrLoss').textContent = '--';
        $('#mtrAvgLatency').textContent = '--';
        const emptyTr = document.createElement('tr');
        emptyTr.innerHTML = `<td colspan="8" style="text-align:center; color:#8b949e; padding:14px;">暂无${label}数据，请先发起拨测</td>`;
        tbody.appendChild(emptyTr);
        return;
    }

    $('#mtrTarget').textContent = data.target;
    $('#mtrHops').textContent = data.hops.length;
    $('#mtrLoss').textContent = data.summary.avgLoss;
    $('#mtrAvgLatency').textContent = data.summary.avgLatency;

    const sourceColor = mode === 'server' ? '#58a6ff' : '#7ee787';
    let sourceLabel = mode === 'server'
        ? `🌐 服务端拨测 · 来源 ${data.source || 'mtr-api'}`
        : `💻 客户端真实路径 · 来源 ${data.format || 'mtr/tracert'}`;

    if (mode === 'server' && data.protocol === 'auto') {
        const attempts = Array.isArray(data.autoAttempts)
            ? data.autoAttempts
                .filter(a => a && a.protocol)
                .map(a => a.ok ? `${a.protocol}${a.hops ? `(${a.hops}跳)` : ''}` : `${a.protocol}(失败)`)
                .join(' → ')
            : '';
        sourceLabel += ` · 自动补探测：${attempts || (data.autoSelectedProtocol || 'auto')}`;
    }

    const banner = document.createElement('tr');
    banner.innerHTML = `<td colspan="8" style="text-align:center; color:${sourceColor}; font-size:12px; padding:8px; background:rgba(255,255,255,0.02);">
        ${sourceLabel} · ${data.hops.length} 跳完整路径
    </td>`;
    tbody.appendChild(banner);

    data.hops.forEach(hop => {
        const tr = document.createElement('tr');
        const lossNum = parseFloat(hop.loss);
        const lossClass = isNaN(lossNum) ? '' : lossNum === 0 ? 'loss-ok' : lossNum < 10 ? 'loss-warn' : 'loss-error';
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

    diagnosisResult.mtr = data;
}

// 自动判断：基于双视角丢包/延迟得出结论
function analyzeMtrComparison() {
    const s = mtrState.server, c = mtrState.client;
    const empty = $('#mtrCompareEmpty'), result = $('#mtrCompareResult');

    if (!s && !c) {
        empty.style.display = 'block';
        empty.textContent = '完成两个视角的拨测后，这里会自动给出判断结论';
        result.style.display = 'none';
        return;
    }
    if (!s || !c) {
        empty.style.display = 'block';
        empty.textContent = `还需要完成 ${!s ? '服务端' : '客户端'} 视角的拨测才能对比`;
        result.style.display = 'none';
        return;
    }

    empty.style.display = 'none';
    result.style.display = 'block';

    $('#cmpServerLoss').textContent = s.summary.avgLoss;
    $('#cmpServerLatency').textContent = s.summary.avgLatency;
    $('#cmpServerHops').textContent = s.hops.length;
    $('#cmpClientLoss').textContent = c.summary.avgLoss;
    $('#cmpClientLatency').textContent = c.summary.avgLatency;
    $('#cmpClientHops').textContent = c.hops.length;

    const sLoss = parseFloat(s.summary.avgLoss);
    const cLoss = parseFloat(c.summary.avgLoss);
    const sLat = parseFloat(s.summary.avgLatency);
    const cLat = parseFloat(c.summary.avgLatency);
    const LOSS_THRESHOLD = 5;     // >5% 视为异常
    const LAT_THRESHOLD = 300;    // >300ms 视为异常（跨国除外）

    const sBad = sLoss > LOSS_THRESHOLD || sLat > LAT_THRESHOLD;
    const cBad = cLoss > LOSS_THRESHOLD || cLat > LAT_THRESHOLD;

    const verdict = $('#mtrVerdictText');
    let html = '';

    if (!sBad && !cBad) {
        html = `<span style="color:#7ee787;">✅ 两条路径均正常</span>。当前网络层无明显丢包和高延迟。<br>
        <span style="color:#8b949e;">建议下一步：</span>检查 HTTP 状态码、TLS 握手、CDN 配置、应用日志。问题大概率不在网络。`;
    } else if (!sBad && cBad) {
        const badHop = findWorstHop(c.hops);
        html = `<span style="color:#f0883e;">⚠️ 客户端视角异常，服务端正常</span>。问题集中在<strong style="color:#e6edf3;">用户客户端到目标</strong>的链路。<br>
        ${badHop ? `异常最严重的跳：第 <strong style="color:#f0883e;">${badHop.hop}</strong> 跳（${badHop.ip}），丢包 ${badHop.loss}，延迟 ${badHop.avg}。<br>` : ''}
        <span style="color:#8b949e;">建议下一步：</span>排查客户端本地网关 / 运营商出口 / 跨国线路。如客户端首跳就异常，重点检查 WiFi/路由器/iOA 代理。`;
    } else if (sBad && !cBad) {
        const badHop = findWorstHop(s.hops);
        html = `<span style="color:#f0883e;">⚠️ 服务端视角异常，客户端正常</span>。问题在<strong style="color:#e6edf3;">服务器到目标</strong>的链路，与终端用户无关。<br>
        ${badHop ? `异常最严重的跳：第 <strong style="color:#f0883e;">${badHop.hop}</strong> 跳（${badHop.ip}），丢包 ${badHop.loss}。<br>` : ''}
        <span style="color:#8b949e;">建议下一步：</span>不影响真实用户，可换服务器机房 / 检查骨干运营商 / 联系 IDC。`;
    } else {
        // 两条都异常 → 找共同异常跳
        const commonBad = findCommonBadHops(s.hops, c.hops);
        html = `<span style="color:#f85149;">🔴 两条路径均异常</span>。问题在<strong style="color:#e6edf3;">目标侧或两条路径共有的中间链路</strong>。<br>
        ${commonBad.length > 0 ? `共同异常跳：<strong style="color:#f85149;">${commonBad.join(', ')}</strong>，通常是目标 CDN 节点或骨干运营商问题。<br>` : ''}
        <span style="color:#8b949e;">建议下一步：</span>联系目标侧（CDN/源站）确认健康状态。EdgeOne 场景下检查节点状态页和健康监控。`;
    }

    // 抖动检测
    const sJitter = jitterScore(s.hops);
    const cJitter = jitterScore(c.hops);
    if (sJitter > 0.3 || cJitter > 0.3) {
        html += `<br><br><span style="color:#f0883e;">📈 抖动警告：</span>${sJitter > 0.3 ? '服务端' : ''}${sJitter > 0.3 && cJitter > 0.3 ? '、' : ''}${cJitter > 0.3 ? '客户端' : ''} 链路抖动较大（max-min &gt; 3×avg），疑似拥塞或链路不稳定。`;
    }

    verdict.innerHTML = html;
}

function findWorstHop(hops) {
    if (!hops || hops.length === 0) return null;
    return hops
        .filter(h => !isNaN(parseFloat(h.loss)) && parseFloat(h.loss) > 0)
        .sort((a, b) => parseFloat(b.loss) - parseFloat(a.loss))[0] || null;
}

function findCommonBadHops(serverHops, clientHops) {
    const sBadIPs = new Set(serverHops.filter(h => parseFloat(h.loss) > 5).map(h => h.ip));
    const common = [];
    clientHops.forEach(h => {
        if (parseFloat(h.loss) > 5 && sBadIPs.has(h.ip)) common.push(h.ip);
    });
    return common;
}

function jitterScore(hops) {
    if (!hops || hops.length === 0) return 0;
    let abnormal = 0;
    hops.forEach(h => {
        const best = parseFloat(h.best);
        const worst = parseFloat(h.worst);
        const avg = parseFloat(h.avg);
        if (!isNaN(best) && !isNaN(worst) && !isNaN(avg) && avg > 0) {
            if ((worst - best) > 3 * avg) abnormal++;
        }
    });
    return abnormal / hops.length;
}

// ==================== 真实 MTR 解析（粘贴模式） ====================
// 支持解析：
//   1) Linux/Mac 的 mtr -r / mtr --report 输出
//   2) Windows tracert 输出
//   3) Mac/Linux traceroute 输出
function parsePastedMTR(text) {
    if (!text || !text.trim()) return null;

    const lines = text.split('\n').map(l => l.replace(/\r/g, ''));
    const hops = [];
    let target = '';
    let format = 'unknown';

    // 检测格式 + 提取目标
    for (const line of lines) {
        // mtr 格式: "HOST: hostname  Loss%  Snt  Last  Avg  Best  Wrst  StDev"
        if (/^\s*HOST:\s+\S+/i.test(line) || /Loss%\s+Snt\s+Last/i.test(line)) {
            format = 'mtr';
        }
        // mtr 报告头: "Start: ... HOST: localhost"  目标在最后一行
        // tracert 格式: "Tracing route to xxx [a.b.c.d]"
        const tracertMatch = line.match(/[Tt]racing route to\s+(\S+)\s*\[([\d.]+)\]/);
        if (tracertMatch) {
            format = 'tracert';
            target = tracertMatch[2] || tracertMatch[1];
        }
        // traceroute 格式: "traceroute to xxx (a.b.c.d), 30 hops max"
        const traceMatch = line.match(/traceroute to\s+(\S+)\s*\(([\d.]+)\)/);
        if (traceMatch) {
            format = 'traceroute';
            target = traceMatch[2];
        }
    }

    // 解析 mtr --report 格式
    // 例: "  1.|-- 192.168.1.1                0.0%    10    0.5   0.6   0.4   0.8   0.1"
    if (format === 'mtr' || /\d+\.\|--/.test(text)) {
        format = 'mtr';
        const mtrLineRe = /^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/;
        for (const line of lines) {
            const m = line.match(mtrLineRe);
            if (m) {
                hops.push({
                    hop: parseInt(m[1]),
                    ip: m[2],
                    hostname: m[2],
                    loss: `${m[3]}%`,
                    sent: m[4],
                    best: `${m[6]} ms`,
                    avg: `${m[7]} ms`,
                    worst: `${m[8]} ms`
                });
            }
        }
    }
    // 解析 Windows tracert 格式
    // 例: "  1     1 ms     1 ms     1 ms  192.168.1.1"
    // 例: "  5     *        *        *     请求超时"
    else if (format === 'tracert') {
        const tracertLineRe = /^\s*(\d+)\s+(.+?)\s+(\S+)\s*$/;
        for (const line of lines) {
            // 跳过表头和空行
            if (!/^\s*\d+\s/.test(line)) continue;
            const m = line.match(/^\s*(\d+)\s+(.+)$/);
            if (!m) continue;
            const hop = parseInt(m[1]);
            const rest = m[2];
            // 三个 RTT + IP/主机名
            // 格式: "1 ms  1 ms  1 ms  192.168.1.1"  或 "* * * 请求超时"
            const ipMatch = rest.match(/(\d+\.\d+\.\d+\.\d+)/);
            const rttMatches = [...rest.matchAll(/(\*|<?\s*\d+)\s*ms/g)];
            const stars = (rest.match(/\*/g) || []).length;
            const ip = ipMatch ? ipMatch[1] : '*';

            const rtts = rttMatches.map(r => {
                const v = r[1].trim();
                if (v === '*') return null;
                return parseFloat(v.replace('<', ''));
            }).filter(v => v !== null);

            const sent = 3;
            const lossRate = stars >= 3 ? '100.0%' : `${((stars / 3) * 100).toFixed(1)}%`;

            if (rtts.length > 0) {
                hops.push({
                    hop,
                    ip,
                    hostname: ip,
                    loss: lossRate,
                    sent: String(sent),
                    best: `${Math.min(...rtts).toFixed(1)} ms`,
                    avg: `${(rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1)} ms`,
                    worst: `${Math.max(...rtts).toFixed(1)} ms`
                });
            } else {
                hops.push({
                    hop, ip: '*', hostname: '请求超时',
                    loss: '100.0%', sent: String(sent),
                    best: '*', avg: '*', worst: '*'
                });
            }
        }
    }
    // 解析 Linux/Mac traceroute 格式
    // 例: " 1  192.168.1.1 (192.168.1.1)  0.5 ms  0.4 ms  0.6 ms"
    else if (format === 'traceroute') {
        const traceLineRe = /^\s*(\d+)\s+(.+)$/;
        for (const line of lines) {
            const m = line.match(traceLineRe);
            if (!m) continue;
            const hop = parseInt(m[1]);
            const rest = m[2];
            const ipMatch = rest.match(/\(([\d.]+)\)/) || rest.match(/(\d+\.\d+\.\d+\.\d+)/);
            const rttMatches = [...rest.matchAll(/([\d.]+)\s*ms/g)];
            const stars = (rest.match(/\*/g) || []).length;
            const ip = ipMatch ? ipMatch[1] : '*';
            const rtts = rttMatches.map(r => parseFloat(r[1]));
            const sent = 3;
            const lossRate = stars >= 3 ? '100.0%' : `${((stars / 3) * 100).toFixed(1)}%`;

            if (rtts.length > 0) {
                hops.push({
                    hop, ip, hostname: ip,
                    loss: lossRate, sent: String(sent),
                    best: `${Math.min(...rtts).toFixed(1)} ms`,
                    avg: `${(rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1)} ms`,
                    worst: `${Math.max(...rtts).toFixed(1)} ms`
                });
            } else if (stars > 0) {
                hops.push({
                    hop, ip: '*', hostname: '* * *',
                    loss: '100.0%', sent: String(sent),
                    best: '*', avg: '*', worst: '*'
                });
            }
        }
    }

    if (hops.length === 0) return null;

    const validLatencies = hops.map(h => parseFloat(h.avg)).filter(v => !isNaN(v));
    const avgLatency = validLatencies.length > 0
        ? (validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length).toFixed(1)
        : '0.0';
    const validLosses = hops.map(h => parseFloat(h.loss)).filter(v => !isNaN(v));
    const avgLoss = validLosses.length > 0
        ? (validLosses.reduce((a, b) => a + b, 0) / validLosses.length).toFixed(1)
        : '0.0';

    return {
        target: target || hops[hops.length - 1].ip,
        mode: 'real-pasted',
        format,
        hops,
        summary: {
            avgLoss: `${avgLoss}%`,
            avgLatency: `${avgLatency} ms`,
            totalHops: hops.length
        }
    };
}

// 渲染粘贴解析的 MTR 结果到现有 UI
function renderPastedMTR(mtrData) {
    mtrState.client = mtrData;
    // 切到客户端视角并渲染
    switchMtrTab('client');
    renderMtrByMode('client');
    analyzeMtrComparison();
    setStatus('mtrStatus', 'success', '已升级为真实数据');
}

// Tab 切换
function switchMtrTab(mode) {
    document.querySelectorAll('.mtr-tab').forEach(tab => {
        const isActive = tab.dataset.mode === mode;
        tab.style.borderBottom = isActive ? '2px solid #58a6ff' : '2px solid transparent';
        tab.style.color = isActive ? '#58a6ff' : '#8b949e';
        tab.style.fontWeight = isActive ? '500' : '400';
        tab.classList.toggle('active', isActive);
    });
    $('#mtrServerPanel').style.display = mode === 'server' ? 'block' : 'none';
    $('#mtrClientPanel').style.display = mode === 'client' ? 'block' : 'none';
    $('#mtrComparePanel').style.display = mode === 'compare' ? 'block' : 'none';

    if (mode === 'server' || mode === 'client') {
        renderMtrByMode(mode);
    } else if (mode === 'compare') {
        analyzeMtrComparison();
    }
}

// 复制命令（带目标域名）
window.copyMtrCmd = function(platform) {
    const target = ($('#targetDomain').value.trim() || diagnosisResult.target || 'edgeone.ai')
        .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const cmd = platform === 'win'
        ? `tracert -d -h 30 ${target}`
        : `sudo mtr -r -w -c 10 -n ${target}`;
    navigator.clipboard.writeText(cmd).then(() => {
        showToast(`已复制：${cmd}`);
    }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = cmd;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(`已复制：${cmd}`);
    });
};

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
    await detectClientInfo();
    progress += steps[0].weight;

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

    // 将 MTR 卡片移动到最后并默认折叠
    const diagnosisGrid = document.querySelector('.diagnosis-grid');
    const mtrCard = $('#mtrCard');
    const mtrCardBody = $('#mtrCardBody');
    const toggleMtrCardBtn = $('#toggleMtrCardBtn');
    if (diagnosisGrid && mtrCard) {
        diagnosisGrid.appendChild(mtrCard);
    }
    if (mtrCardBody && toggleMtrCardBtn) {
        const updateMtrToggle = (expanded) => {
            mtrCardBody.style.display = expanded ? 'block' : 'none';
            toggleMtrCardBtn.textContent = expanded ? '折叠' : '展开';
            toggleMtrCardBtn.style.color = expanded ? '#58a6ff' : '#8b949e';
            toggleMtrCardBtn.style.borderColor = expanded ? '#58a6ff' : '#30363d';
        };
        updateMtrToggle(false);
        toggleMtrCardBtn.addEventListener('click', () => {
            const expanded = mtrCardBody.style.display === 'none';
            updateMtrToggle(expanded);
        });
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

    // 真实 MTR 粘贴解析
    const parseBtn = $('#parseMtrBtn');
    if (parseBtn) {
        parseBtn.addEventListener('click', () => {
            const text = $('#mtrPasteInput').value;
            const hint = $('#mtrParseHint');
            if (!text.trim()) {
                hint.textContent = '⚠️ 请先粘贴 mtr 或 tracert 命令的输出';
                hint.style.color = '#f0883e';
                return;
            }
            const result = parsePastedMTR(text);
            if (!result) {
                hint.textContent = '❌ 无法识别格式，请确保粘贴的是完整的 mtr / tracert / traceroute 输出';
                hint.style.color = '#f85149';
                return;
            }
            renderPastedMTR(result);
            hint.textContent = `✓ 已解析 ${result.hops.length} 跳真实客户端路由（格式: ${result.format}），自动切换到对比视角查看判断结论`;
            hint.style.color = '#7ee787';
            // 解析成功后自动切到对比视角
            setTimeout(() => switchMtrTab('compare'), 800);
        });
    }
    const clearBtn = $('#clearMtrBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            $('#mtrPasteInput').value = '';
            $('#mtrParseHint').textContent = '';
        });
    }

    // 视角 Tab 切换
    document.querySelectorAll('.mtr-tab').forEach(tab => {
        tab.addEventListener('click', () => switchMtrTab(tab.dataset.mode));
    });

    // 配置 mtr-api 地址
    const configBtn = $('#configMtrApiBtn');
    if (configBtn) {
        // 初始化显示：localStorage 优先，其次 CONFIG 默认值
        const saved = localStorage.getItem('mtrApiBase');
        if (saved !== null) {
            CONFIG.mtrApiBase = saved;
        }
        if (CONFIG.mtrApiBase) {
            $('#mtrApiUrl').textContent = CONFIG.mtrApiBase;
            $('#mtrApiUrl').style.color = '#7ee787';
        }
        configBtn.addEventListener('click', () => {
            const cur = CONFIG.mtrApiBase || '';
            const url = prompt('请输入 mtr-api 后端地址（例：http://14.116.239.35:3089）\n留空则清除配置', cur);
            if (url === null) return;
            CONFIG.mtrApiBase = url.trim();
            if (CONFIG.mtrApiBase) {
                localStorage.setItem('mtrApiBase', CONFIG.mtrApiBase);
                $('#mtrApiUrl').textContent = CONFIG.mtrApiBase;
                $('#mtrApiUrl').style.color = '#7ee787';
                showToast('已保存 mtr-api 地址，下次诊断生效');
            } else {
                localStorage.removeItem('mtrApiBase');
                $('#mtrApiUrl').textContent = '未配置';
                $('#mtrApiUrl').style.color = '#8b949e';
            }
        });
    }

    // 服务端单独拨测按钮
    const probeBtn = $('#probeServerBtn');
    if (probeBtn) {
        probeBtn.addEventListener('click', async () => {
            const target = ($('#targetDomain').value.trim() || diagnosisResult.target || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            if (!target) { showToast('请先输入诊断目标'); return; }
            if (!CONFIG.mtrApiBase) { showToast('请先配置 mtr-api 后端地址'); return; }
            probeBtn.textContent = '拨测中...';
            probeBtn.disabled = true;
            try {
                const resp = await fetchWithTimeout(
                    `${CONFIG.mtrApiBase}/mtr?target=${encodeURIComponent(target)}&protocol=auto&port=80`,
                    {}, 60000
                );
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                if (data.error) throw new Error(data.error);
                data.mode = 'server';
                data.source = 'mtr-api';
                mtrState.server = data;
                renderMtrByMode('server');
                analyzeMtrComparison();
                showToast(`✓ 服务端拨测完成：${data.hops.length} 跳`);
            } catch (e) {
                showToast('❌ 服务端拨测失败：' + e.message);
            } finally {
                probeBtn.textContent = '从服务端拨测';
                probeBtn.disabled = false;
            }
        });
    }
});
