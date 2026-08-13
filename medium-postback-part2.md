# 一顆「換一批」背後要記住什麼？我和 Codex 設計 Firestore 搜尋 Session

上一篇，我和 Codex 決定讓 Postback data 只帶一個短 session ID：

```text
v=1&a=reroll&s=abc123
```

但真正的位置、偏好與上一批店家要放在哪裡？

這篇只處理這個問題。我不會重新介紹 Postback action，也不談後面的 handler 與部署，而是專注在 Codex 如何設計一個短期、可驗證、能防止連點的 Firestore 搜尋 session。

---

## 🗃️ Codex 先排除兩個看似簡單的方案

第一個方案是存在 Cloud Run 記憶體。

它實作很快，但 Cloud Run 可能重啟，也可能同時有多個 instance。第一次位置搜尋與下一次 Postback 不一定會落在同一台機器上。

第二個方案是請使用者每次重新傳位置。

這雖然不需要保存資料，卻直接失去「換一批」的便利性。

Codex 最後選擇 Firestore，因為這次需要的是跨 request、跨 instance 的短期狀態，而且現有服務本來就在 Google Cloud 上。

這不是要建立完整會員資料庫，而是替一次搜尋留下 30 分鐘的記憶。

---

## 🧱 Session 只保存下一步真的用得到的資料

Codex 設計的文件大致如下：

```text
cafe-search-sessions/{sessionId}
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

每個欄位都有下一步用途：

- `ownerId`：確認是誰建立搜尋
- `conversationId`：確認搜尋來自哪個 LINE 對話
- `latitude`、`longitude`：不必重新分享的位置
- `preference`：保留目前搜尋偏好
- `previousCafeNames`：讓下一批優先避開舊結果
- `expiresAt`：拒絕太舊的按鈕
- `processingUntilMs`：防止同一時間重複執行

Codex 沒有保存 Gemini 完整回答、整張 Flex Message 或所有 Maps metadata，因為下一次搜尋用不到。

Session 越小，資料風險、讀寫成本與未來清理負擔也越小。

---

## 🔐 Session ID 很難猜，不代表可以省略授權

Firestore 自動產生的 ID 不容易碰巧猜中，但 Codex 沒把「難猜」當成安全設計。

每次 Postback 都要同時符合：

```text
session.ownerId === event.source.userId
session.conversationId === currentConversationId
```

只檢查使用者不夠，因為同一個人可能在不同對話操作 Bot；只檢查聊天室也不夠，因為群組裡可能有多位成員。

Codex 將使用者與對話一起綁定。驗證失敗時，Bot 不會透露 session 裡的座標或店家，只會請目前使用者重新建立自己的搜尋。

這讓一顆留在聊天紀錄裡的舊按鈕，不會變成讀取其他搜尋狀態的入口。

---

## ⏱️ 程式負責守門，TTL 負責打掃

LINE 訊息會留在聊天室，但搜尋狀態不需要永久存在。

Codex 將 session 有效期限設成 30 分鐘。超過時間再按，應用程式會直接拒絕，要求重新傳送位置。

Firestore 另外根據 `expiresAt` 啟用 TTL，自動刪除過期文件。

這裡有一個容易混淆的重點：TTL 刪除不是即時發生。

所以 Codex 沒有用「文件是否已被刪除」判斷按鈕是否有效，而是每次都由程式比較 `expiresAt`。

- 應用程式時間檢查：決定現在能不能操作
- Firestore TTL：稍後清除不再需要的資料

Codex 用一句很容易懂的方式整理：程式負責守門，TTL 負責打掃。

---

## 🛑 防連點不能只放在單一 Node.js Process

使用者等待 AI 搜尋時，很可能因為沒有立刻看到結果而連續點擊。

如果五次點擊都真的呼叫 Gemini，不只會收到重複訊息，也會浪費 API 用量。

Codex 沒有在程式裡放一個普通布林值，因為不同 Cloud Run instance 不會共享它。

它改用 Firestore transaction：

1. 讀取 session
2. 驗證擁有者、對話與有效期限
3. 檢查目前是否已有處理鎖
4. 寫入 90 秒的 `processingUntilMs`
5. 搜尋完成或失敗後釋放

讀取與上鎖在同一個 transaction 裡。兩個幾乎同時到達的點擊，只有一個能取得執行權。

另一個請求會收到：

```text
上一個搜尋還在進行中，請稍等結果出現。
```

這個鎖保護的不只是畫面，也保護模型成本。

---

## 🧯 新增能力失敗，不該拖垮原本搜尋

Codex 在設計 session 時，又多問了一個問題：

> 如果 Firestore 暫時不能寫入，第一次咖啡廳搜尋還要不要回覆？

答案是要。

第一次搜尋已經拿到結果後，程式才嘗試建立 session：

- 建立成功：顯示「換一批」與「更適合工作」
- 建立失敗：照常送出推薦，只保留「重新選位置」

用白話來說，續杯服務壞了，不代表第一杯咖啡也不能端上桌。

Codex 將 Postback 做成漸進式增強，而不是讓新的 Firestore 依賴成為舊功能的單點故障。

---

## 🏆 第二篇總結：Bot 的記憶也需要邊界

Codex 最後做出的 session 有幾個清楚限制：

- 只保存下一步需要的資料
- 只允許原使用者在原對話操作
- 30 分鐘後由應用程式拒絕
- 過期文件再交給 TTL 清除
- 用 transaction 防止連點
- Firestore 失敗時不影響第一次搜尋

這些限制讓「記得上一輪」不會變成「什麼都永久保存」。

我原本只想要一顆「換一批」，Codex 卻讓我看到，真正成熟的狀態設計不是記得越多越好，而是只記得必要內容，而且知道何時失效。

下一篇會進入程式實作：Postback handler 如何接進既有事件流程、怎麼真的排除上一批店家，以及 Codex 把哪些部分放進測試。

---

### 📂 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
