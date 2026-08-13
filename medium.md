# 我用 Codex 讓 LINE 咖啡廳 Bot 可以「換一批」：從 Postback Action、Firestore 到正式上線

今天我替 Zona Cafe LINE Bot 加了一個看起來很自然、做下去才發現很有深度的新功能：

> 使用者收到附近咖啡廳推薦後，可以直接點「換一批」或「更適合工作」，不用重新傳位置，也不用自己再打一段話。

原本的 Bot 已經可以接收位置，透過 Vertex AI Gemini 的 Google Maps Grounding 找出附近 3～5 間咖啡廳，再回傳繁體中文摘要與 Google Maps 卡片。

但整個流程是一次性的：傳位置、拿結果、結束。

所以今天我先請 Codex 不要急著寫程式，而是先幫我評估 LINE Messaging API 的 `Postback action` 到底適不適合。確認方向後，Codex 才開始規劃資料、實作、測試、部署，最後真的把 LINE webhook 切到新版服務。

這篇只記錄今天完成的內容：Postback action、Firestore 搜尋狀態、連點保護、Cloud Run 部署，以及 Codex 怎麼把一個按鈕一路做成真正可以在線上使用的功能。

---

## Postback action 不是功能本身，而是讓 Bot 繼續對話的方法

一開始我把 LINE 官方的 Postback action 文件丟給 Codex，問它適不適合加進 Zona Cafe。

Codex 先提醒我一個很重要的觀念：

> Postback action 是互動機制，不是完整功能。

如果使用者只是要打開 Google Maps，目前的 `URI action` 就已經很適合，不需要全部換成 Postback。

Postback 真正適合的是這種需要後端繼續處理的操作：

- 換一批咖啡廳
- 改成工作友善優先
- 收藏店家
- 回報推薦是否有幫助
- 依照上一次搜尋繼續下一步

使用者點下按鈕後，LINE 不會把它當成一般文字訊息，而是送一個 `postback` event 到 webhook。後端可以從 `postback.data` 知道使用者想做什麼，再執行相對應的邏輯。

Codex 最後建議第一版先做兩個最有感、又不會一次把範圍拉太大的動作：

- `換一批`
- `更適合工作`

至於收藏與歷史紀錄，Codex 建議等資料模型更完整後再做，因為那會開始牽涉長期保存的使用者資料。

---

## 真正困難的不是按鈕，而是 Bot 要記得「剛才發生什麼」

Postback 按鈕本身並不難，真正的問題是：

> 使用者點「換一批」時，Bot 要去哪裡找回他剛才的位置與上一批店家？

原本 Zona Cafe 收到位置後，搜尋完成就把結果送出去，後端沒有保存狀態。等下一個 Postback event 進來時，只會知道使用者點了按鈕，卻不知道應該在哪裡重新搜尋。

最直覺的做法，是把經緯度、偏好與上一批結果全部塞進 `postback.data`。但 Codex 沒有這樣做。

LINE 的 Postback data 最多只有 300 個字元，而且這些資料會回到客戶端按鈕裡。把完整狀態塞進去，不只空間不夠，也很難管理與驗證。

所以 Codex 採用比較乾淨的設計：Postback data 只放短指令與 session ID。

```text
v=1&a=reroll&s=abc123
v=1&a=work_friendly&s=abc123
```

這三個欄位分別代表：

- `v`：資料格式版本
- `a`：要執行的 action
- `s`：這次搜尋的 session ID

真正的座標、偏好與上一批店名，則交給 Firestore 保存。

Codex 幫我設計的搜尋 session 大致是這樣：

```text
searchSessions/{sessionId}
  ownerId
  conversationId
  latitude
  longitude
  preference
  previousCafeNames
  createdAt
  expiresAt
  processingUntilMs
```

用白話來說，Postback 按鈕像是一張取餐號碼牌。號碼牌不需要印出整份訂單，只要讓後端能找到正確的訂單就夠了。

---

## Codex 不只讓它「記得」，也限制誰可以使用這次搜尋

只把狀態存進 Firestore 還不夠。

如果有人拿到另一個人的 session ID，是否就可以一直觸發對方的搜尋？如果使用者連續點五次「換一批」，是否會同時送出五次 Gemini 請求？如果隔天再點舊訊息裡的按鈕，又該怎麼辦？

Codex 在第一版就補上了三層保護。

### 1. Session 綁定使用者與聊天室

每個 session 都會記錄：

- 哪一位 LINE 使用者建立
- 從哪一個對話建立

Postback event 進來後，Codex 寫的 handler 會同時比對 `ownerId` 與 `conversationId`。不屬於這位使用者或這個聊天室的操作不會被執行。

### 2. Session 30 分鐘後失效

搜尋狀態只需要短期存在，因此 Codex 將有效時間設成 30 分鐘。

過期後再點舊按鈕，Bot 會請使用者重新傳送位置。Firestore 另外啟用 TTL，讓 Google Cloud 自動清除過期文件，不讓暫存資料一直累積。

### 3. 用 Firestore transaction 防止連點

Codex 在 session 裡加入 `processingUntilMs`，並透過 Firestore transaction 取得 90 秒處理鎖。

第一個點擊取得鎖之後，下一個點擊會收到「上一個搜尋還在進行中」的提示，而不是再呼叫一次 Gemini。

這個細節很重要，因為 AI 搜尋不只需要時間，也會產生 API 用量。如果一顆按鈕能被快速連點，每次都真的送出請求，使用者體驗與成本都會一起失控。

---

## 「換一批」不只是重跑一次相同 Prompt

如果只是拿同一組座標、同一段 prompt 再呼叫 Gemini，結果很可能還是原本那幾間店。

所以 Codex 把上一批咖啡廳名稱存進 session。使用者點「換一批」時，這些店名會成為新的搜尋條件：有其他選擇時，優先避開上一批結果。

概念上像這樣：

```typescript
const result = await findNearbyCafes(latitude, longitude, {
  preference,
  excludeNames: session.previousCafeNames
});
```

「更適合工作」則會把 preference 改成 `work_friendly`，要求 Gemini 優先採用 Google Maps 中有明確證據、比較適合坐下來或使用筆電的店家。

Codex 同時保留了一條很重要的限制：

> 沒有資料時，不可以自行推測插座、Wi-Fi、不限時或安靜程度。

這表示「更適合工作」是一個搜尋偏好，不是假裝每間推薦都已經通過完整設備驗證。Codex 沒有為了讓功能看起來更厲害，就犧牲 Grounding 的可信度。

---

## 使用者最後看到的，其實只有三顆很簡單的按鈕

後端增加了 session、權限、transaction 與新 prompt，但使用者不需要理解任何一項。

Codex 在原本的 Google Maps Flex Message 下方加入三個 Quick Reply：

- 換一批
- 更適合工作
- 重新選位置

前兩個是 Postback action，最後一個繼續使用 LINE 原生的 location action。

```typescript
{
  type: 'postback',
  label: '換一批',
  data: createCafePostbackData('reroll', sessionId),
  displayText: '🔄 換一批咖啡廳'
}
```

這也是我很喜歡這次實作的地方：Codex 沒有為了使用 Postback，就把所有按鈕都硬改成 Postback，而是讓不同 action 繼續做各自最適合的工作。

---

## Codex 也重整了 webhook event 的分流

原本 handler 只處理 `message` event。今天加入 Postback 後，Codex 先讓 webhook dispatcher 能辨認新的事件類型：

```typescript
if (event.type === 'postback') {
  await handlePostbackEvent(event);
  return;
}
```

接著再由專門的 `postbackHandler.ts` 負責：

1. 解析 Postback data
2. 驗證 action 白名單
3. 確認使用者與聊天室
4. 從 Firestore 取得 session 與處理鎖
5. 顯示 Loading Animation
6. 重新呼叫 Maps Grounding
7. 更新 session 與上一批店家
8. Push 新結果回 LINE

Codex 沒有把這整段塞回原本的 location handler。這樣未來新增收藏或其他 Postback action 時，程式還有清楚的擴充位置。

今天 Codex 也讓 webhook 在簽章驗證後先回 `200`，再處理較慢的 Gemini 工作，並讓 Cloud Run 使用 `--no-cpu-throttling` 保持 response 結束後的運算資源。

這是目前 MVP 的取捨。Codex 也保留了清楚的下一步：如果未來流量增加，長時間工作應該移到 Cloud Tasks 或其他 queue，而不是永遠依賴單一 Cloud Run instance 的背景 Promise。

---

## 測試不是只確認「按鈕有出現」

Codex 完成程式後，補了幾個很實際的測試：

- Postback data 可以正確產生與解析
- 不支援的版本會被拒絕
- 不在白名單內的 action 會被拒絕
- 不合法的 session ID 會被拒絕
- 有 session 時會出現兩個 Postback action
- Firestore 不可用時，第一次搜尋仍可回傳結果，只保留重新傳位置
- Google Maps sources 仍會正確去重

最後執行：

```bash
npm run typecheck
npm test
```

TypeScript 型別檢查通過，5 項測試全部成功。

Codex 在這裡幫我守住一個原則：Postback 是新功能，但不能讓原本「傳位置找咖啡廳」的主要流程因為 Firestore 暫時失敗就整個消失。

---

## 寫完 code 只完成一半，Codex 接著把它真的放上線

今天指定的新 GitHub repo 一開始是空的：

```text
https://github.com/zonawang/codex-postback-action
```

Codex 先以目前的 `line-map-grounding` 作為基底，讓新 repo 成為可以獨立建置與部署的完整服務，再加入今天的 Postback 功能。

中間也遇到幾個很真實的小阻礙：

- npm 使用者快取權限錯誤
- 新 repo 沒有 Git author identity
- HTTPS remote 沒有可用的 GitHub 登入

Codex 沒有改動全域設定，也沒有清掉原本快取。它改用任務專用 npm 暫存快取、沿用既有 commit 的作者資料，最後切換到原本已設定好的 GitHub SSH 身分完成 push。

程式上 GitHub 後，Codex 繼續處理 Google Cloud：

- 確認 Firestore Native database 已存在於 `asia-east1`
- 啟用 Vertex AI 與 Firestore API
- 建立專用 Cloud Run service account
- 授予 `roles/aiplatform.user`
- 授予 `roles/datastore.user`
- 授予 `roles/serviceusage.serviceUsageConsumer`
- 啟用 Firestore TTL
- 部署新的 Cloud Run service

部署完成後，Codex 沒有直接切換正式 Bot，而是先確認：

- Cloud Run revision 已 serving 100% traffic
- `/health` 回傳 `200`
- 新服務沒有 Cloud Run error logs
- 舊服務網址仍然保留，可以回復

最後 Codex 才將 LINE webhook 從舊服務切換到新版，並呼叫 LINE 官方 Verify。

驗證結果是：

```text
success: true
statusCode: 200
reason: OK
```

到這一步，「換一批」才不只是 GitHub 裡的一段 code，而是真的進入 Zona Cafe 的線上對話流程。

---

## 今天我對 Codex 最有感的地方：先評估，再規劃，最後做完整閉環

今天我沒有一開始就叫 Codex 寫 code。

我先請 Codex 評估 Postback action 適不適合目前的 Bot。Codex 先區分 URI action、location action 與 Postback action 的責任，再指出真正需要解決的是搜尋狀態，而不是按鈕外觀。

方向確認後，Codex 才把工作拆成：

- Postback data schema
- Firestore session
- 使用者與聊天室驗證
- 過期與連點保護
- Gemini 搜尋偏好
- LINE Quick Reply
- 單元測試
- GitHub
- IAM
- Cloud Run
- LINE webhook 切換與回復方案

這次 Codex 的價值，不只是把 `type: 'postback'` 寫進物件。

它真正幫我完成的是一整條產品鏈路：使用者點下按鈕、LINE 送出 event、後端找回狀態、安全地重新搜尋、Bot 回傳新結果，最後在線上環境通過驗證。

**一顆看似簡單的「換一批」，背後其實需要狀態、安全、成本控制、雲端權限與部署策略。Codex 做得最好的地方，是沒有跳過這些看不見、卻真正決定功能能不能長久使用的部分。**

---

### 📂 今天的完整程式碼

👉 Postback Action 專案：
https://github.com/zonawang/codex-postback-action

👉 Zona Cafe Maps Grounding 前一階段：
https://github.com/zonawang/line-map-grounding

👉 更多過往專案整理：
https://github.com/zonawang/zona-ai-learning-lab

如果你也正在用 Codex 開發 LINE Bot，希望今天這篇能讓你少踩一點「按鈕很簡單，狀態卻不簡單」的坑。
