# cf-email-web

這是一個部署在 Cloudflare Workers 上的收信、轉寄與查信工具。

它的用途是：

- 接收 Cloudflare Email Routing 導進來的郵件
- 自動轉寄到一個或多個指定信箱
- 把信件保存起來，方便日後回顧
- 提供一個有密碼保護的 Web 介面查閱信件

這個專案特別適合這類情境：

- 公司或專案有共用收件地址，例如 `hello@...`、`support@...`
- 需要把信即時轉給同事
- 但又不能只依賴個人信箱保存歷史信件
- 同事流動後，仍然需要從系統回頭查舊信

目前預設儲存方式是：

- `R2`：保存完整信件內容
- `KV`：保存 Web 收件匣索引

這樣可以兼顧長期保存與快速瀏覽。

## 功能

- 使用 Cloudflare `email(message, env, ctx)` 接收進站郵件
- 使用 `message.forward(...)` 轉寄到一個或多個目的信箱
- 預設把完整信件 JSON 存到 `R2`
- 把最新信件索引存到 `KV`
- 提供密碼保護的 Web UI
- 可查看信件列表、單封信內容與 raw preview
- 可解析常見的 `text/plain`、`text/html`
- 可解碼常見的 `base64` 與 `quoted-printable`

## 專案檔案

- `src/index.js`
  Worker 主程式，包含收信、轉寄、儲存、登入驗證與 Web UI。
- `wrangler.jsonc`
  Cloudflare Worker 設定檔。
- `.dev.vars.example`
  本機開發時可參考的環境變數範例。
- `package.json`
  專案指令與相依套件設定。

## 系統需求

部署前請先確認：

- 已安裝 Node.js
- 已安裝 `npm`
- 已安裝 `wrangler`
- 已登入 Cloudflare CLI
- Cloudflare 帳號中已啟用目標網域的 Email Routing

本專案目前使用的 Cloudflare account ID 是：

```text
aa3bf2b79b8bbdbf05b4e289bd7c4d91
```

## 安裝步驟

### 1. 下載專案

如果是從 GitHub 取得：

```bash
git clone https://github.com/tbdavid2019/cf-email-web.git
cd cf-email-web
```

### 2. 安裝相依套件

```bash
npm install
```

### 3. 確認 Wrangler 已登入 Cloudflare

```bash
wrangler whoami
```

如果尚未登入：

```bash
wrangler login
```

### 4. 設定 Worker secrets

這些值不應該直接寫死在程式碼或 git repo 裡，應存成 Cloudflare secrets。

先設定 Web 登入密碼：

```bash
wrangler secret put ADMIN_PASSWORD
```

再設定 session 簽章用的高強度亂數字串：

```bash
wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` 不需要人類記住，建議使用隨機長字串。

例如可先產生：

```bash
openssl rand -base64 48
```

再把結果貼進 `wrangler secret put SESSION_SECRET`。

### 5. 設定轉寄目標

如果你要自動轉寄到某個信箱或多個信箱，設定：

```bash
wrangler secret put FORWARD_TO
```

單一信箱範例：

```text
david@aicreate360.com
```

多個信箱範例：

```text
alice@example.com,bob@example.com,carol@example.com
```

注意：

- 多個信箱之間用逗號分隔
- Cloudflare Email Routing 轉寄通常要求目標地址已驗證
- 如果某個目標地址未驗證，轉寄可能失敗

### 6. 設定儲存後端

本專案支援兩種儲存模式：

- `r2`
- `kv`

目前預設是 `r2`，設定寫在 [wrangler.jsonc](/Users/david/Documents/git/tbdavid2019/cf-email-web/wrangler.jsonc)：

```jsonc
"vars": {
  "STORAGE_BACKEND": "r2"
}
```

兩者差異：

- `r2`
  完整信件內容存到 R2，KV 只存索引。適合長期保存。
- `kv`
  完整信件內容直接存 KV。適合簡單測試，不建議長期保存大量資料。

如果你想切成 `kv`，把 `STORAGE_BACKEND` 改成：

```text
kv
```

### 7. 部署 Worker

```bash
npm run deploy
```

第一次部署時，Wrangler 會依照 `wrangler.jsonc` 自動建立需要的資源：

- `MAIL_STORE` 對應的 KV Namespace
- `MAIL_BUCKET` 對應的 R2 Bucket

部署完成後，會得到一個 Workers 網址，例如：

```text
https://cf-email-web.ai360.workers.dev
```

## Cloudflare 後台設定

部署完 Worker 之後，還需要把 Email Routing 導到這個 Worker，不然信不會進來。

### 1. 打開目標網域的 Cloudflare Dashboard

進入：

- `Email`
- `Email Routing`

### 2. 建立或修改 Routing rule

你可以用兩種方式：

- `Catch-all`
- 指定某個地址，例如 `hello@yourdomain.com`

### 3. Action 選擇 `Send to a Worker`

Destination 選擇：

```text
cf-email-web
```

### 4. 確認規則為 Active

當規則生效後，寄到該地址的信會進入這個 Worker。

## Web 介面使用方式

部署後打開 Worker 網址：

```text
https://cf-email-web.ai360.workers.dev
```

第一次進入會看到登入頁。

登入密碼就是你設定的：

```text
ADMIN_PASSWORD
```

登入後可使用：

- Inbox 列表頁
- 單封信詳細頁
- 原始 raw 內容查看

## 重要參數說明

### `ADMIN_PASSWORD`

用途：

- Web 查信頁面的登入密碼

設定方式：

```bash
wrangler secret put ADMIN_PASSWORD
```

建議：

- 不要使用太弱的密碼
- 如果多人共用，應有內部管理規範

### `SESSION_SECRET`

用途：

- 用來簽署登入 session cookie

設定方式：

```bash
wrangler secret put SESSION_SECRET
```

建議：

- 使用長度足夠的隨機字串
- 不要用可猜測的人類密碼
- 不要提交到 git

### `FORWARD_TO`

用途：

- 指定收到信後要自動轉寄到哪些信箱

設定方式：

```bash
wrangler secret put FORWARD_TO
```

格式：

```text
user1@example.com,user2@example.com,user3@example.com
```

注意：

- 可設定多個信箱
- 若留空，Worker 仍可收信與保存，但不會轉寄

### `STORAGE_BACKEND`

用途：

- 控制完整信件內容要存到哪裡

可用值：

- `r2`
- `kv`

預設值：

```text
r2
```

## 本機開發

如果要在本機測試：

1. 建立 `.dev.vars`
2. 參考 `.dev.vars.example` 填入本機變數
3. 啟動開發模式

範例：

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

`.dev.vars` 可包含：

```text
ADMIN_PASSWORD=change-this-password
SESSION_SECRET=change-this-long-random-secret
FORWARD_TO=you@example.com,backup@example.com
STORAGE_BACKEND=r2
```

注意：

- `.dev.vars` 不應提交到 git
- `.gitignore` 已排除 `.dev.vars`

## 運作流程

整體流程如下：

1. 外部寄件者寄信到你的網域信箱
2. Cloudflare Email Routing 收到信
3. Routing rule 把信送到 `cf-email-web`
4. Worker 執行 `email(message, env, ctx)`
5. Worker 保存信件到 `R2` 或 `KV`
6. Worker 依 `FORWARD_TO` 設定轉寄信件
7. 你可從 Web UI 登入查看歷史信件

## SMTP 說明

本專案目前不是透過外部 SMTP server 發信。

它使用的是 Cloudflare 官方提供的機制：

- 進站信件由 Cloudflare Email Routing 接收
- Worker 內直接使用 `message.forward(...)` 進行轉寄

這代表：

- 不需要自行提供 SMTP host
- 不需要 SMTP 帳號密碼
- 不需要自行處理寄信程式邏輯

這種方式比自己串 SMTP 簡單很多，也比較符合這個專案的需求。

## 已知限制

- Web 收件匣索引目前只保留最新 `200` 封信
- raw MIME preview 目前會截斷在約 `300 KB`
- MIME 解析是實用型實作，不是完整 RFC 等級 parser
- 複雜 multipart、附件、巢狀轉寄格式未必都能完美顯示
- 如果要更完整解析附件與 MIME 結構，後續建議引入專用 parser

## 常見檢查點

如果你發現寄信後沒有作用，請先檢查：

1. Email Routing rule 是否是 `Active`
2. Action 是否為 `Send to a Worker`
3. Destination 是否選到 `cf-email-web`
4. `FORWARD_TO` 是否已正確設定
5. 目標轉寄信箱是否已完成 Cloudflare 驗證
6. 是否能在 Worker 網頁中看到信件
7. 是否可用 `wrangler tail` 看到 email event

常用除錯指令：

```bash
wrangler tail
wrangler whoami
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
wrangler secret put FORWARD_TO
```

## 部署指令整理

最常用的完整流程如下：

```bash
npm install
wrangler whoami
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
wrangler secret put FORWARD_TO
npm run deploy
```

## 目前部署資訊

目前專案已部署在：

```text
https://cf-email-web.ai360.workers.dev
```

GitHub repository：

```text
https://github.com/tbdavid2019/cf-email-web
```
