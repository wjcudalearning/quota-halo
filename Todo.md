# Codenotch for Windows — Todo

審查日期：2026-09-07

這份清單是依照目前 Windows 版本的程式碼、實際啟動畫面，以及上游
[vinzdg/codenotch](https://github.com/vinzdg/codenotch) 的設計規格整理而成。

優先級：

- **P0**：會影響正式使用、打包或資料正確性
- **P1**：下一版應完成的 UI／Windows 體驗
- **P2**：品質、擴充性與長期維護
- **P3**：可延後的產品功能

## 已確認的現況

- [x] Electron 主程序、preload、renderer 與多 provider 架構已經分開。
- [x] DeepSeek、OpenRouter、Claude、Codex、Antigravity 已有基本讀取與錯誤狀態。
- [x] 收合狀態是置頂黑色膠囊，展開後顯示 provider rings。
- [x] Windows Credential Manager、DSH credentials、Claude/Codex 設定檔已有讀取邏輯。
- [ ] 目前畫面資訊偏密，收合膠囊只有一個主數值加狀態點；展開後的詳細資訊主要塞在 footer 文字。
- [ ] UI 仍大量使用 Unicode／emoji 圖示，尚未建立一致的 icon、focus、hover、pressed 狀態。
- [ ] 專案目前沒有 Git metadata，也沒有 `npm test` script；後續要補上可重現的驗證流程。

## P0 — 先修正式可用性

### 打包與發佈

- [x] 統一 `package.json` 的 `package`、`pack`、`dist` 三套流程。
  - 目前 `package` 使用 `electron-packager`，但 `pack`／`dist` 使用 `electron-builder`。
  - `devDependencies` 只有 `electron-packager`，沒有 `electron-builder`，所以目前安裝環境無法直接執行 `npm run dist`。
- [x] 明確確認 electron-builder 的 `build.files` 是否包含 `renderer/**/*`；主程式在 `src/main.js` 會載入 `renderer/index.html` 與 `renderer/settings.html`。
- [x] 加入 package smoke test：打包後確認 main、renderer、settings、assets 都存在，再啟動 portable exe 驗證畫面能載入。
- [x] 移除 hard-coded 的 `0.2.0`，改由 `package.json` version 統一產出檔名與 app version。
- [x] 補上 Windows `.ico` 應用程式圖示、tray 多尺寸圖示與高 DPI 資源；目前 `build.win` 沒有指定 app icon。
- [x] 在 README 明確寫出唯一推薦的安裝／打包流程，避免使用者誤用不存在的 `electron-builder` 指令。

### Poll／刷新生命週期

- [x] 在 `runPoll()` 增加 single-flight 保護，避免手動 Refresh、計時器與啟動初次刷新同時打 API。
- [x] provider timeout 目前用 `Promise.race`，超時後原本的 provider promise 仍可能繼續執行；改用可取消的 `AbortController` 或 provider-level cancellation。
- [x] 為各 provider 加上 `Retry-After`、429 backoff、網路離線與恢復策略，避免 API 暫時失敗時固定頻率重試。
- [x] refresh 失敗時，在畫面上區分「離線」、「認證失效」、「API rate limit」、「資料格式變更」與一般錯誤。

### Last good reading 與資料正確性

- [x] 將 last good snapshot 持久化到 userData；重開程式後不要因冷啟動暫時連不上就顯示空白。
- [x] stale reading 保存原始 `updatedAt`，顯示「最後成功更新於多久前」，不要只顯示本次 fetch 失敗時間。
- [x] expired token 應保留上一筆數值並明確標示 expired／stale；只有真的沒有任何可信讀值時才顯示空白。
- [x] 建立統一的 snapshot schema：`provider`、`windows[]`、`headline`、`fidelity`、`status`、`updatedAt`，避免每個 provider 自己決定欄位語意。
- [x] 明確定義「used」與「remaining」；目前不同 provider 的 ring 可能代表不同方向，畫面上要標示 `USED`／`LEFT`，不可只靠顏色猜測。

## P1 — UI／視覺升級

### Notch 收合狀態

- [ ] 建立 Windows 版視覺語言：保留黑色 notch 概念，但加入細微邊框、半透明層次、柔和陰影／光暈與 Windows 11 Fluent 感，避免看起來像單純黑色 HTML bar。
- [x] 收合膠囊改成「狀態摘要」：主 provider 數值、目前最需要注意的 provider、其他 provider 狀態點，以及上次更新時間。
- [ ] 依內容自動調整 pill 寬度；長數值、中文 provider 名稱、`SIGN IN`、`STALE` 不應被截斷成難以理解的片段。
- [x] 所有 provider 都失敗時增加清楚的 empty/error state，例如「暫時無法讀取」與可直接開啟設定的操作提示。
- [x] 把忙碌狀態、rate limit、stale、expired、needsAuth 做成一致的 badge 與動畫，不要只靠 ring 顏色。

### 展開卡片與詳細資訊

- [x] 參照上游設計，把目前 footer 的單行字串升級為真正的 detail panel／tooltip：provider glyph、名稱、方案、每個 limit window、進度 bar、reset 倒數。
- [x] hover 某個 provider 時只突出該 provider，其餘卡片降低對比；加入對準該 cell 的小 tail，讓使用者知道詳細資料屬於誰。
- [x] 每個 limit window 使用獨立的 4–6px progress bar，顯示 `N% used` 或 `N% left`，並在一小時內用相對時間、較長時間用絕對日期。
- [x] 將最受限的 window 作為 provider headline，而不是固定取第一個正常 provider；DeepSeek／OpenRouter 的金額則用 money-specific layout，不要偽裝成百分比 ring。
- [x] 卡片標題加入「last updated」與資料可信度（official／derived／manual）；derived 數值要明顯但不干擾閱讀地標示 `~`。
- [x] 為卡片加入 empty state、loading skeleton、error retry、認證操作提示，避免網路請求期間畫面只剩 dash。
- [x] 加入右鍵選單：Refresh、Settings、Pin、Hide temporarily、Quit；目前主要互動在 tray，notch 本身不夠完整。

### 顏色、字體與 icon

- [ ] 統一所有 provider 的警戒門檻與語意：例如 green／watch／critical 對應同一套 used percentage；DeepSeek 金額則另定義清楚的金額門檻。
- [x] 檢查橘、黃、綠在黑底上的對比度與色盲辨識；狀態不可只依賴顏色，應搭配文字、圖示或形狀。
- [x] 將 refresh、pin、settings、close 等 Unicode／emoji 改成同一套 inline SVG 或 icon font，避免不同 Windows 字型顯示成不同風格。
- [x] 增加 hover、pressed、focus-visible、disabled 狀態；目前按鈕主要只有 hover，鍵盤操作回饋不足。
- [x] 加入 `prefers-reduced-motion`，讓使用者可以停用旋轉 ring、pulse 與展開動畫。
- [x] 放大過小的輔助文字；目前不少 caption／hint 是 8–10.5px，長時間監看不易閱讀。

### Settings 視窗

- [x] 將目前長頁面改成更清楚的分組：Providers、Credentials、Appearance、Polling、About；保留單頁也可以，但每組要有說明與視覺 hierarchy。
- [ ] provider row 加上品牌 glyph、目前狀態、最後讀取結果與 toggle switch；目前只有原生 checkbox 和描述文字。
- [ ] 若要支援自訂順序，加入 drag handle、鍵盤排序與顯示順序預覽；若暫時不支援，明確標示 order is fixed。
- [x] OpenRouter key 加上顯示／隱藏、清除、驗證連線與最後四碼提示；不要要求使用者只能靠改字串觸發儲存。
- [ ] 憑證探測改成可操作的 status cards：找到檔案、缺少 key、token expired、無法讀取，各自提供下一步。
- [ ] 調整設定頁固定高度與小字密度，支援 Windows 縮放 125%／150% 及較長的繁體中文說明。
- [x] 支援 `Esc` 關閉設定、Tab 順序、Enter／Space 操作、screen reader label 與可見 focus ring。
- [x] 加入「恢復預設值」與「清除本機設定」；執行清除前要有明確確認與範圍說明。

### 語系與文案

- [x] 建立最小 i18n 層，至少支援繁體中文與英文；目前主 notch 多為英文、設定頁為繁中，語系不一致。
- [x] 統一用語：Notch、provider／供應商、usage／用量、credit／餘額、refresh／重整、sign in／登入。
- [ ] 所有錯誤訊息補上「發生什麼事」與「使用者下一步」，不要直接把檔案路徑或 HTTP 狀態當成完整 UX。

## P1 — Windows 行為與系統整合

- [x] 支援多螢幕：目前 `workArea()` 固定使用 primary display；改為記錄目前 display、監聽 display added／removed／metrics changed，並在 DPI 改變時重新定位。
- [x] 重新設計拖曳行為：記住使用者選擇的螢幕與位置，避免每次啟動都回到 primary display 中央。
- [ ] 評估是否支援 left／right edge；若 Windows 版只保留 top／bottom，要在 Settings 與 README 清楚說明產品取捨。
- [ ] 實測 Windows taskbar 自動隱藏、不同 taskbar 位置、全螢幕 app、Windows snap 與多種 scaling，確認 notch 不會遮住重要內容。
- [x] 評估 `screen-saver` always-on-top 層級；避免 overlay 在遊戲、簡報或全螢幕工作時過度干擾，提供 auto-hide／fullscreen hide 選項。
- [ ] 讓 tray menu 與 notch actions 共用同一套狀態，包含 show／hide、pin、refresh、settings、quit。
- [ ] 啟用「登入時啟動」後回讀 Windows login item 狀態；若被群組政策或系統阻擋，要在 Settings 顯示原因。
- [ ] 補上 Windows 通知選項：token expired、provider recovered、critical quota 只在狀態真正變更時通知，避免每輪 poll 打擾。

## P2 — Provider 與 Windows 憑證層

- [ ] 將 OpenRouter API key 從明文 JSON settings 移到 Windows Credential Manager 或 DPAPI；設定檔只保存是否已設定與非敏感 metadata。
- [ ] 憑證檔案顯示使用 `%USERPROFILE%`／Windows path，並處理 `DSH_HOME`、不同使用者帳號與檔案權限錯誤。
- [ ] YAML parser 目前只是小型 `key: value` subset；改用已驗證的 parser 或補齊 comment、quoted value、特殊字元與 multiline 的測試。
- [ ] Antigravity transcript 不要每次把整個 `transcript.jsonl` 讀入記憶體；以檔案 offset、mtime cache 或 tail scan 降低輪詢成本。
- [ ] `activity.js` 目前每 10 秒遞迴掃描 sessions；加入 mtime cache／watcher，避免 session 數量增加後拖慢主程序。
- [ ] 為各 provider 保存 response fixtures 與 parser contract tests；私有 endpoint 變更時要能快速知道是哪個 parser 失效。
- [ ] 顯示 provider source／fidelity 及 API 最後回應時間，讓使用者知道數字是官方值、推導值還是本機計數。
- [ ] 整理或移除未使用的 `src/balance.js`，避免 legacy DeepSeek 流程與現在的 `src/providers/deepseek.js` 造成維護混淆。
- [ ] 對 `wincred.js`、PowerShell P/Invoke 與 language server discovery 增加錯誤日誌、版本相容性檢查與 timeout 測試。

## P2 — 測試、品質與維護

- [ ] 建立 `npm test`，至少涵蓋金額格式化、百分比／remaining 轉換、reset time、stale cache、credential parser、provider enable flags。
- [ ] 增加 renderer fixture mode，固定展示「全正常、部分 stale、全部 needsAuth、超長文字、0 provider」等狀態。
- [ ] 增加 Electron screenshot regression，檢查收合 pill、展開 card、上／下邊緣、125%／150% scaling。
- [ ] 加入 lint／format script，統一 JavaScript、HTML、CSS 的 style，並在打包前先執行 syntax check。
- [ ] 為 IPC handler 驗證輸入型別、provider id、edge、refreshSeconds；不只依賴 renderer 傳入正確值。
- [ ] 為外部 URL 建立 allowlist，並讓設定頁所有可操作連結都走同一個安全 helper。
- [ ] README 補上已知限制、Windows Credential Manager、private API 可能變動、offline 行為、解除安裝與設定檔位置。

## P3 — 可以之後再做

- [ ] provider 自訂排序與拖曳重新排列。
- [ ] 手動 provider／自訂額度，支援沒有官方 API 的服務。
- [ ] 歷史用量與簡單趨勢圖；先確保目前即時讀值可靠，再做歷史資料。
- [ ] 匯出診斷報告、匿名化 log 與一鍵複製 debug info。
- [ ] 自動更新、簽章與 portable／installer 兩種發佈模式。
- [ ] 設定同步或多機 profile；涉及敏感憑證前先完成 secure storage。

## 建議實作順序

1. **P0 打包與生命週期**：統一打包、補 renderer smoke test、修 polling overlap 與 stale persistence。
2. **P1 核心 UI**：先完成 detail panel、清楚的 loading/error/stale state、SVG icons 與 responsive sizing。
3. **P1 Windows 體驗**：多螢幕、DPI、fullscreen、tray/notch menu、登入啟動驗證。
4. **P1 Settings**：provider status cards、secure key flow、i18n、鍵盤與 screen reader 支援。
5. **P2 品質**：provider fixtures、renderer screenshot tests、README 與正式 portable／installer build。

## 上游設計對照重點

上游規格特別強調 provider detail tooltip、每個 limit window 的 reset 資訊、最受限 window 作為 headline，以及 derived／stale 數值不可偽裝成官方即時值；這些是 Windows 版最值得優先補回來的產品核心，而不只是換顏色或加陰影。

