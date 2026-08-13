# LINE Bot 的「換一批」為什麼需要資料庫？我和 Codex 從 Postback 按鈕設計到 Firestore Session

今天我替 Zona Cafe LINE Bot 加了一個很符合直覺的新功能：

> 看完附近咖啡廳推薦後，直接點「換一批」或「更適合工作」，不用重新傳位置。

原本的 Bot 已經能根據使用者位置推薦咖啡廳，但每次互動都是單程的：使用者傳位置，Bot 回結果，流程就結束了。

我一開始以為，只要在結果下面多放一顆按鈕就好。直到我把 LINE Postback action 的文件丟給 Codex，才發現真正要處理的不是按鈕，而是 Bot 有沒有能力記得上一輪對話。

這篇不重新介紹 LINE 定位、Google Maps Grounding 或 Cloud Run。那些前面的版本已經完成了。這篇只談今天的新問題：Codex 怎麼判斷 Postback 適不適合、為什麼需要 Firestore，以及一個短期搜尋 session 應該怎麼設計才不會留下安全與成本問題。

---

## 🔘 Codex 先問的不是「按鈕長什麼樣」，而是「按下去要發生什麼」

Postback action 本身不是一個產品功能。

它比較像一個通知後端的開關：使用者點擊後，LINE 會將預先設定的資料放進 `postback.data`，再透過 webhook 送回 Bot。

所以 Codex 在評估時先把幾種常見 action 的責任分開：

- 打開 Google Maps：繼續使用 `URI action`
- 重新分享位置：繼續使用 `location action`
- 讓後端沿用上次狀態繼續工作：使用 `Postback action`

這個區分很重要。

如果只是為了「有用到 Postback」，把所有按鈕都換掉，程式會變複雜，使用者卻沒有得到任何新能力。

Codex 最後建議第一版只做兩個真的需要後端狀態的動作：

1. `換一批`：沿用原位置，盡量避開上一批店家。
2. `更適合工作`：沿用原位置，調高工作友善偏好的權重。

至於「重新選位置」，它本來就是 LINE 原生 location action 擅長的事，不需要硬繞一圈 Postback。

這也是今天第一個設計決定：**先從使用者意圖選 action，而不是先選 API 再找地方使用。**

---

## 🧠 一顆「換一批」，要求 Bot 記住三件事

使用者點下「換一批」時，新的 webhook event 不會自動附上上一輪搜尋的全部內容。

後端至少要自己找回：

- 上次搜尋的經緯度
- 使用者目前的搜尋偏好
- 上一批已經推薦過哪些店

少了位置，就不知道去哪裡找；少了偏好，搜尋條件會突然重設；少了上一批店名，「換一批」可能只是把相同結果再送一次。

Codex 先帶我比較了幾種做法。

### 做法一：請使用者重新傳位置

這最容易實作，但「換一批」就失去意義。使用者每按一次，都要重新打開地圖與分享位置，操作成本沒有真的下降。

### 做法二：把全部資料放進 Postback data

LINE 的 Postback data 最多 300 個字元。座標本身不大，但再加上偏好、上一批店家與未來可能增加的條件，很快就會變成難以維護的壓縮包。

更重要的是，按鈕帶回來的資料不能直接當成可信任的後端狀態。

### 做法三：存在 Cloud Run 記憶體

Codex 很快排除了這個選項。Cloud Run 可能重啟，也可能同時有多個 instance。第一次搜尋與下一次 Postback 不一定會落在同一台機器上。

### 做法四：Postback 只帶 session ID，狀態放 Firestore

這是 Codex 最後採用的方式。

Postback data 保持非常短：

```text
v=1&a=reroll&s=abc123
```

- `v` 是資料格式版本
- `a` 是允許執行的 action
- `s` 是搜尋 session ID

按鈕只像一張取件單。真正的資料留在伺服器端，後端收到 session ID 後再去 Firestore 找回。

---

## 🗂️ Codex 怎麼設計一個只活 30 分鐘的搜尋 Session

這個 session 不是會員資料，也不是長期歷史紀錄。

它只是為了讓使用者在短時間內繼續操作同一次搜尋，所以 Codex 刻意把資料範圍壓小：

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

每個欄位都有明確用途：

- `ownerId`：誰建立了這次搜尋
- `conversationId`：搜尋發生在哪個 LINE 對話
- `latitude`、`longitude`：下一次不用重新分享的位置
- `preference`：目前採用的搜尋偏好
- `previousCafeNames`：下一批應優先避開的店家
- `expiresAt`：何時不再接受這顆舊按鈕
- `processingUntilMs`：防止短時間重複執行

Codex 沒有把 Gemini 的完整回答、整張 Flex Message 或所有 Google Maps metadata 都存進去。

原因很簡單：下一次搜尋不需要那些資料。Session 越小，Firestore 成本、資料風險與後續維護負擔也越小。

---

## 🔐 只有 Session ID 還不夠，還要確認是誰在按

Firestore 自動產生的 session ID 很難猜，但「很難猜」不能取代權限驗證。

Codex 在每次 Postback 執行前，同時檢查兩個條件：

```text
session.ownerId === event.source.userId
session.conversationId === currentConversationId
```

第一個條件確認是同一位使用者；第二個條件確認操作發生在原本的對話。

這在群組情境特別重要。

如果只綁群組 ID，同一個群組裡的其他人可能點擊不是自己建立的搜尋。只綁使用者 ID，也可能讓同一個按鈕被帶到不相干的對話流程。

Codex 將兩者一起綁定，讓 session 的使用範圍更接近使用者真正看到那組結果時的情境。

驗證失敗時，Bot 不會透露 session 裡的內容，只會請使用者重新傳送自己的位置。

---

## ⏱️ 舊按鈕不應該永遠有效

LINE 訊息會一直留在聊天室裡，但背後的搜尋狀態不需要永久保存。

Codex 將 session 有效期限設成 30 分鐘。

這個時間足以讓使用者比較幾批咖啡廳，又不會讓幾天前的按鈕突然使用舊座標重新搜尋。

過期時分成兩層處理：

1. 應用程式讀取 session 時，先檢查 `expiresAt`，過期就拒絕操作。
2. Firestore TTL 根據 `expiresAt`，在背景自動清除過期文件。

Codex 特別沒有把 TTL 當成即時權限機制。Firestore 的實體刪除可能稍晚發生，所以真正決定按鈕能不能使用的，仍然是應用程式自己的時間檢查。

TTL 負責打掃，程式驗證負責守門。兩者的責任不同。

---

## 🛑 使用者連點五次，不應該產生五次 Gemini 請求

AI 搜尋不是固定文字回覆。

它需要呼叫模型、取得 Grounded 結果、整理來源，再轉成 LINE 訊息。使用者如果因為等待而連續點擊，「換一批」很容易在幾秒內產生多個相同工作。

Codex 沒有只在 Node.js 裡放一個布林值，因為不同 Cloud Run instance 之間不會共享那個值。

它改用 Firestore transaction：

1. Transaction 讀取 session。
2. 檢查 session 是否過期、是否屬於目前使用者。
3. 檢查 `processingUntilMs` 是否仍在有效時間內。
4. 沒有其他工作時，寫入一個 90 秒處理鎖。
5. 搜尋完成或失敗後釋放鎖。

因為讀取與上鎖在同一個 transaction 裡，即使兩次點擊幾乎同時到達，也只有一個能成功取得處理權。

另一個點擊會收到清楚提示：

```text
上一個搜尋還在進行中，請稍等結果出現。
```

這個設計不只是防止畫面出現重複訊息，也直接保護 Gemini API 用量。

---

## 🧯 Firestore 暫時失敗時，原本功能還能不能用？

Codex 在規劃時又問了一個很實際的問題：

> Postback 是新增能力，但它是否應該變成第一次咖啡廳搜尋的必要條件？

最後答案是不要。

第一次位置搜尋完成後，程式會嘗試建立 Firestore session。如果寫入成功，結果下方就出現「換一批」與「更適合工作」。

如果 Firestore 暫時無法寫入，Bot 仍然會把已經找到的咖啡廳結果送出去，只是不顯示需要 session 的 Postback 選項，保留「重新選位置」。

用白話來說，續杯服務暫時不能用，不代表第一杯咖啡也不能端上桌。

Codex 把 Postback 定位成漸進式增強，而不是把整個核心搜尋綁在新依賴上。

---

## 🏆 第一篇總結：狀態設計才是這顆按鈕真正的功能

今天這一段最有意思的地方，是畫面上的變化其實很小。

使用者只多看到兩個選項，但 Codex 在背後處理了：

- Action 的責任分工
- 300 字元內的版本化 Postback data
- Firestore 短期 session
- 使用者與聊天室雙重綁定
- 30 分鐘應用層過期判斷
- Firestore TTL 清理
- Transaction 連點鎖
- Firestore 失敗時的功能降級

如果今天直接請 Codex「幫我加一顆換一批按鈕」，可能很快就會看到按鈕，卻未必會得到一個能在多 instance、群組情境與真實連點下正常工作的功能。

這次我先讓 Codex 評估，再讓 Codex 把看不見的狀態問題攤開來設計。最後我學到的是：

> 互動式 Bot 的下一步，通常不是再多一個 handler，而是開始認真面對狀態。

下一篇會接著寫 Codex 如何把這套設計放進既有程式，包括 Postback parser、handler、搜尋排除、Quick Reply、測試，以及如何不影響舊服務地安全切換到線上版本。

---

### 📂 本篇完整程式碼

👉 Postback Action 專案：
https://github.com/zonawang/codex-postback-action

👉 Zona Cafe Maps Grounding 基礎版本：
https://github.com/zonawang/line-map-grounding

👉 更多過往專案整理：
https://github.com/zonawang/zona-ai-learning-lab

