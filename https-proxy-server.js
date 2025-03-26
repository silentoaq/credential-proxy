const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const httpProxy = require('http-proxy');

// 配置文件路徑
const CONFIG_PATH = path.join(__dirname, 'issuers-config.json');
const CERTS_DIR = path.join(__dirname, 'certs');

// 默認發行者配置
const DEFAULT_ISSUERS = {
  'fido.moi.gov.tw': {
    target: 'https://localhost:5000',
    name: '內政部自然人憑證',
  },
  'land.moi.gov.tw': {
    target: 'https://localhost:5001',
    name: '內政部房產憑證',
  },
  'zuvi.io': {
    target: 'https://localhost:5002',
    name: '租房 Dapp',
  }
};

// 確保證書目錄存在
if (!fs.existsSync(CERTS_DIR)) {
  fs.mkdirSync(CERTS_DIR, { recursive: true });
}

// 讀取配置文件
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      console.log('成功載入配置檔案');
      return config;
    }
  } catch (err) {
    console.error('讀取配置檔案錯誤:', err);
  }
  
  // 如果沒有配置文件或讀取錯誤，使用默認配置並嘗試寫入
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_ISSUERS, null, 2));
    console.log('已創建默認配置檔案');
  } catch (err) {
    console.error('創建配置檔案錯誤:', err);
  }
  
  return DEFAULT_ISSUERS;
}

// 保存配置文件
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('已保存配置檔案');
    return true;
  } catch (err) {
    console.error('保存配置檔案錯誤:', err);
    return false;
  }
}

// 添加新的發行者
function addIssuer(hostname, target, name) {
  const config = loadConfig();
  config[hostname] = { target, name };
  return saveConfig(config);
}

// 創建代理服務器
const proxy = httpProxy.createProxyServer({
  secure: false, // 允許自簽名證書
  changeOrigin: true
});

// 處理代理錯誤
proxy.on('error', (err, req, res) => {
  console.error('代理錯誤:', err);
  res.writeHead(500, {
    'Content-Type': 'text/plain'
  });
  res.end(`代理錯誤: ${err}`);
});

// 請求處理
function handleRequest(req, res) {
  const hostname = req.headers.host.split(':')[0]; // 移除端口號
  const config = loadConfig();
  
  // 處理代理管理 API（僅限本地訪問）
  if (hostname === 'localhost' && req.url.startsWith('/proxy-admin')) {
    handleAdminRequest(req, res);
    return;
  }
  
  // 檢查是否有匹配的發行者
  if (config[hostname]) {
    console.log(`將請求代理至 ${config[hostname].target}`);
    proxy.web(req, res, { target: config[hostname].target });
  } else {
    // 自動發現模式：嘗試訪問 /.well-known/openid-credential-issuer 
    if (req.url === '/.well-known/openid-credential-issuer') {
      // 使用動態發現嘗試找到正確的端口
      discoverIssuer(hostname, req, res);
    } else {
      // 返回錯誤，未配置的主機
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: '未配置的發行者',
        message: `找不到 ${hostname} 的配置，請在代理管理頁面添加此發行者。`,
        admin_url: 'https://localhost:8080/proxy-admin'
      }));
    }
  }
}

// 處理管理 API 請求
function handleAdminRequest(req, res) {
  res.setHeader('Content-Type', 'application/json');
  
  // 列出所有發行者
  if (req.url === '/proxy-admin/list' && req.method === 'GET') {
    res.end(JSON.stringify(loadConfig()));
    return;
  }
  
  // 添加新發行者
  if (req.url === '/proxy-admin/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { hostname, target, name } = JSON.parse(body);
        if (!hostname || !target) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: '缺少必要參數' }));
          return;
        }
        
        if (addIssuer(hostname, target, name || hostname)) {
          res.end(JSON.stringify({ success: true, message: '發行者已添加' }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: '保存配置失敗' }));
        }
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '請求格式錯誤' }));
      }
    });
    return;
  }
  
  // 管理界面
  if (req.url === '/proxy-admin' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>發行者代理管理 (HTTPS)</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          button { padding: 8px 12px; background-color: #4CAF50; color: white; border: none; cursor: pointer; }
          input, select { padding: 8px; margin-bottom: 10px; width: 100%; box-sizing: border-box; }
          .code-block { background-color: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; }
        </style>
      </head>
      <body>
        <h1>HTTPS 發行者代理管理</h1>
        
        <h2>當前配置的發行者</h2>
        <table id="issuers-table">
          <thead>
            <tr>
              <th>域名</th>
              <th>目標服務</th>
              <th>名稱</th>
            </tr>
          </thead>
          <tbody id="issuers-list"></tbody>
        </table>
        
        <h2>添加新發行者</h2>
        <form id="add-form">
          <div>
            <label for="hostname">域名 (如 example.com)</label>
            <input type="text" id="hostname" required>
          </div>
          <div>
            <label for="target">目標服務 URL (如 https://localhost:5000)</label>
            <input type="text" id="target" required>
          </div>
          <div>
            <label for="name">顯示名稱 (選填)</label>
            <input type="text" id="name">
          </div>
          <button type="submit">添加發行者</button>
        </form>
        
        <h2>本地主機檔案配置提示</h2>
        <p>請在您的 /etc/hosts 文件中添加以下行：</p>
        <pre id="hosts-suggestion" class="code-block">127.0.0.1  fido.moi.gov.tw land.moi.gov.tw zuvi.io</pre>
        
        <h2>HTTPS 證書生成指南</h2>
        <div class="code-block">
          <p>使用 mkcert 為本地域名生成證書:</p>
          <pre>mkcert -install
mkcert fido.moi.gov.tw land.moi.gov.tw zuvi.io localhost 127.0.0.1 ::1</pre>
          <p>將生成的證書文件移動到 certs 目錄:</p>
          <pre>mv fido.moi.gov.tw+5.pem certs/cert.pem
mv fido.moi.gov.tw+5-key.pem certs/key.pem</pre>
          <p>重啟代理服務器以使用新證書。</p>
        </div>
        
        <script>
          // 加載發行者列表
          function loadIssuers() {
            fetch('/proxy-admin/list')
              .then(response => response.json())
              .then(data => {
                const tbody = document.getElementById('issuers-list');
                tbody.innerHTML = '';
                let hostsSuggestion = '127.0.0.1  ';
                
                Object.entries(data).forEach(([hostname, config]) => {
                  const row = document.createElement('tr');
                  row.innerHTML = \`
                    <td>\${hostname}</td>
                    <td>\${config.target}</td>
                    <td>\${config.name || hostname}</td>
                  \`;
                  tbody.appendChild(row);
                  hostsSuggestion += hostname + ' ';
                });
                
                document.getElementById('hosts-suggestion').textContent = hostsSuggestion;
              })
              .catch(error => console.error('加載發行者錯誤:', error));
          }
          
          // 添加發行者
          document.getElementById('add-form').addEventListener('submit', function(e) {
            e.preventDefault();
            const hostname = document.getElementById('hostname').value;
            const target = document.getElementById('target').value;
            const name = document.getElementById('name').value;
            
            fetch('/proxy-admin/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hostname, target, name })
            })
              .then(response => response.json())
              .then(data => {
                if (data.success) {
                  alert('發行者已添加');
                  loadIssuers();
                  document.getElementById('add-form').reset();
                } else {
                  alert('錯誤: ' + (data.error || '添加失敗'));
                }
              })
              .catch(error => console.error('添加發行者錯誤:', error));
          });
          
          // 初始加載
          loadIssuers();
        </script>
      </body>
      </html>
    `);
    return;
  }
  
  // 未知的管理端點
  res.writeHead(404);
  res.end(JSON.stringify({ error: '未找到請求的管理端點' }));
}

// 自動發現發行者
async function discoverIssuer(hostname, req, res) {
  console.log(`嘗試發現發行者: ${hostname}`);
  
  // 可能的端口列表
  const ports = [5000, 5001, 5002, 5003, 5004, 5005, 8080, 8081, 8082, 8000, 8001];
  
  // 嘗試每個端口
  for (const port of ports) {
    const target = `https://localhost:${port}`;
    try {
      console.log(`嘗試 ${target}/.well-known/openid-credential-issuer`);
      
      // 創建請求
      const options = {
        hostname: 'localhost',
        port: port,
        path: '/.well-known/openid-credential-issuer',
        method: 'GET',
        timeout: 1000, // 1秒超時
        rejectUnauthorized: false // 允許自簽名證書
      };
      
      // 發送請求
      const success = await new Promise((resolve) => {
        const testReq = https.request(options, (testRes) => {
          if (testRes.statusCode === 200) {
            // 成功找到
            console.log(`在端口 ${port} 找到發行者`);
            addIssuer(hostname, target, `自動發現的發行者 (${hostname})`);
            
            // 代理原始請求
            proxy.web(req, res, { target });
            resolve(true);
          } else {
            resolve(false);
          }
        });
        
        testReq.on('error', () => resolve(false));
        testReq.on('timeout', () => {
          testReq.destroy();
          resolve(false);
        });
        
        testReq.end();
      });
      
      if (success) return;
    } catch (err) {
      console.log(`端口 ${port} 無響應`);
    }
  }
  
  // 所有端口都失敗
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: '未找到發行者',
    message: `無法自動發現 ${hostname} 的服務。請確保服務運行並在代理管理頁面添加此發行者。`,
    admin_url: 'https://localhost:8080/proxy-admin'
  }));
}

// 啟動 HTTP 和 HTTPS 服務器
function startServers() {
  // 檢查證書文件是否存在
  const certPath = path.join(CERTS_DIR, 'cert.pem');
  const keyPath = path.join(CERTS_DIR, 'key.pem');
  
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error('錯誤: 找不到 SSL 證書文件');
    console.log('請使用以下命令生成證書:');
    console.log('  mkcert -install');
    console.log('  mkcert fido.moi.gov.tw land.moi.gov.tw zuvi.io localhost 127.0.0.1 ::1');
    console.log('  mv fido.moi.gov.tw+5.pem certs/cert.pem');
    console.log('  mv fido.moi.gov.tw+5-key.pem certs/key.pem');
    process.exit(1);
  }
  
  // 讀取證書文件
  const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  
  // 嘗試在標準 HTTPS 端口 (443) 上運行
  const STANDARD_HTTPS_PORT = 443;
  const FALLBACK_HTTPS_PORT = process.env.HTTPS_PORT || 8080;
  
  // 創建 HTTPS 服務器
  const httpsServer = https.createServer(httpsOptions, handleRequest);
  
  // 先嘗試在端口 443 上啟動（需要管理員權限）
  httpsServer.listen(STANDARD_HTTPS_PORT, () => {
    console.log(`✅ HTTPS 反向代理服務器運行在標準端口 (443)!`);
    console.log(`現在可以直接訪問 https://fido.moi.gov.tw 無需輸入端口號`);
    console.log(`管理界面: https://localhost/proxy-admin`);
  }).on('error', (err) => {
    if (err.code === 'EACCES') {
      console.log(`⚠️ 無法在標準端口 (443) 上啟動，嘗試在 ${FALLBACK_HTTPS_PORT} 上啟動...`);
      console.log('如果想使用標準端口 (443)，請以管理員權限重新運行:');
      console.log('  Windows: 以系統管理員身份運行 PowerShell 或命令提示符，然後執行');
      console.log('  > node https-proxy-server.js');
      
      // 在非標準端口上啟動
      httpsServer.listen(FALLBACK_HTTPS_PORT, () => {
        console.log(`HTTPS 反向代理服務器運行在 https://localhost:${FALLBACK_HTTPS_PORT}`);
        console.log(`管理界面: https://localhost:${FALLBACK_HTTPS_PORT}/proxy-admin`);
      });
    } else {
      console.error(`啟動 HTTPS 服務器時發生錯誤:`, err);
    }
  });
  
  // 創建 HTTP 服務器 (僅用於重定向到 HTTPS)
  const httpServer = http.createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] || 'localhost';
    const httpsUrl = `https://${host}${req.url}`;
    res.writeHead(301, { Location: httpsUrl });
    res.end();
  });
  
  // 嘗試在標準 HTTP 端口 (80) 上運行
  const STANDARD_HTTP_PORT = 80;
  const FALLBACK_HTTP_PORT = process.env.HTTP_PORT || 8081;
  
  httpServer.listen(STANDARD_HTTP_PORT, () => {
    console.log(`✅ HTTP 重定向服務器運行在標準端口 (80)`);
  }).on('error', (err) => {
    if (err.code === 'EACCES') {
      console.log(`⚠️ 無法在標準端口 (80) 上啟動 HTTP 服務器，嘗試在 ${FALLBACK_HTTP_PORT} 上啟動...`);
      
      // 在非標準端口上啟動
      httpServer.listen(FALLBACK_HTTP_PORT, () => {
        console.log(`HTTP 重定向服務器運行在 http://localhost:${FALLBACK_HTTP_PORT}`);
      });
    } else {
      console.error(`啟動 HTTP 服務器時發生錯誤:`, err);
    }
  });
}

// 啟動服務器
startServers();