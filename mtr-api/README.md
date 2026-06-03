# MTR API 服务

轻量级 MTR 路由追踪后端 API，配合客户端探测工具使用。

## 前置要求

- Linux 服务器（CVM / Lighthouse / 任何 VPS）
- Node.js >= 16
- mtr 工具已安装

## 快速部署

```bash
# 1. 安装 mtr
sudo apt install mtr-tiny   # Debian/Ubuntu
# 或
sudo yum install mtr         # CentOS/RHEL

# 2. 克隆代码并启动
cd mtr-api
node index.js

# 3. 使用 pm2 守护进程（推荐）
npm install -g pm2
pm2 start index.js --name mtr-api
pm2 save
pm2 startup
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| MTR_PORT | 3089 | 监听端口 |

## API 接口

### GET /health
健康检查

### GET /mtr?target=IP或域名
执行 MTR 路由追踪

**参数：**
- `target`（必填）：目标 IP 或域名

**响应示例：**
```json
{
  "target": "8.8.8.8",
  "source": "server",
  "hops": [
    {
      "hop": 1,
      "ip": "10.0.0.1",
      "hostname": "gateway",
      "loss": "0.0%",
      "sent": "10",
      "best": "0.3 ms",
      "avg": "0.5 ms",
      "worst": "1.2 ms",
      "stdev": "0.2 ms"
    }
  ],
  "summary": {
    "avgLoss": "0.0%",
    "avgLatency": "12.3 ms",
    "totalHops": 8
  }
}
```

**错误码：**
- 400：参数缺失或格式错误
- 429：频率限制（每 IP 每分钟最多 3 次）
- 500：服务端执行失败

## 安全建议

1. 生产环境务必配置 Nginx 反向代理 + HTTPS
2. 限制 CORS 白名单（修改代码中 `ALLOWED_ORIGINS`）
3. 可添加 IP 白名单或 Token 鉴权

## Nginx 反代参考

```nginx
server {
    listen 443 ssl;
    server_name mtr-api.yourdomain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3089;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
    }
}
```

## 前端对接

在 `diagnosis.js` 中设置：
```javascript
const CONFIG = {
    mtrApiBase: 'https://mtr-api.yourdomain.com',
    // ...
};
```
