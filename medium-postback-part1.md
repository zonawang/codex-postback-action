# LINE Bot 的「換一批」該用哪種按鈕？我請 Codex 先評估 Postback 再動手

今天我想替 Zona Cafe LINE Bot 加一個新功能：

> 使用者看完附近咖啡廳推薦後，可以直接點「換一批」或「更適合工作」。

原本我以為這只是多放兩顆按鈕，但我先把 LINE Postback action 的文件交給 Codex，請它只做評估，不要急著寫 code。

Codex 很快指出，真正要問的不是「Postback 能不能用」，而是「使用者按下去之後，後端需不需要繼續工作」。

這篇只談今天第一個決定：為什麼選 Postback、哪些按鈕不該用 Postback，以及按鈕帶回後端的資料應該長什麼樣。

---

## 🔘 Postback 不是功能，而是一條回到後端的路

使用者點擊 Postback action 後，LINE 會送出一個 `postback` event，後端再從 `postback.data` 判斷下一步。

所以 Codex 先把三種需求分開：

- 打開 Google Maps：使用 `URI action`
- 重新提供座標：使用 `location action`
- 沿用上一次搜尋繼續處理：使用 `Postback action`

如果只是為了「有用到 Postback」，把所有按鈕都換掉，程式變複雜，使用者卻沒有得到新能力。

Codex 最後建議只有兩個動作使用 Postback：

1. `換一批`：沿用原位置，再找不同店家。
2. `更適合工作`：沿用原位置，改變搜尋偏好。

「重新選位置」仍交給 LINE 原生 location action；「在 Google Maps 查看」也繼續使用 URI action。

今天第一個學到的原則是：

> 先從使用者意圖選 action，不要先選 API 再找地方使用。

---

## 🧠 點擊事件不會自動記得上一輪對話

Postback event 會告訴後端「有人按了按鈕」，卻不會自動附上上一輪搜尋的全部狀態。

但「換一批」至少需要知道：

- 上次在哪個位置搜尋
- 目前採用哪一種偏好
- 前一批已經推薦哪些店

少了位置，後端不知道去哪裡找；少了上一批店家，新結果可能和舊結果完全相同。

也就是說，Postback 解決的是「再次通知後端」，不是「自動保存記憶」。

Codex 因此把問題拆成兩層：

1. 按鈕只描述使用者想做什麼。
2. 搜尋狀態由後端另外保存。

這個拆法讓 LINE 按鈕保持簡單，也避免畫面上的 action 承擔不該承擔的資料責任。

---

## 📦 300 個字元，不適合塞進整份搜尋狀態

LINE 的 Postback data 最多 300 個字元。

最直覺的做法，是把座標、偏好與上一批店名全部放進去。但 Codex 沒有採用，原因不只是空間有限。

按鈕帶回來的是外部輸入。資料越複雜，後端越難驗證，也越容易讓未來格式改版變成災難。

Codex 最後將 data 壓到只剩三個欄位：

```text
v=1&a=reroll&s=abc123
```

- `v`：資料格式版本
- `a`：使用者選擇的 action
- `s`：後端搜尋 session ID

「更適合工作」則是：

```text
v=1&a=work_friendly&s=abc123
```

這段資料很短，但已足夠讓後端知道該去哪裡取回狀態，以及接下來要執行哪一條流程。

---

## 🧾 Codex 為什麼一開始就放版本欄位？

目前只有兩個 action，看起來直接寫：

```text
action=reroll
```

好像也能用。

但 LINE 舊訊息會長期留在聊天室。未來即使新版 Bot 改了資料格式，使用者仍可能點到幾週前的按鈕。

Codex 加入 `v=1`，讓後端可以明確拒絕不認得的版本。哪天格式真的需要修改，也能建立新的 parser，而不是猜測一段舊資料代表什麼。

Codex 同時把 action 限制在白名單：

```typescript
type CafePostbackAction = 'reroll' | 'work_friendly';
```

後端不會把 `a` 裡的任意文字直接拿去執行，也不會直接拼進 Firestore path 或 Gemini prompt。

小小的版本與白名單，讓 Postback data 從一段字串變成一個有邊界的 protocol。

---

## 💬 人看到的文字，和程式收到的指令應該分開

使用者在聊天室看到的是：

```text
🔄 換一批咖啡廳
```

後端收到的則是：

```text
v=1&a=reroll&s=abc123
```

Codex 利用 `displayText` 與 `data` 將兩者分工。

`displayText` 可以自然、容易理解；`data` 則保持短、小、穩定、適合程式解析。

這樣未來即使按鈕文案從「換一批」改成「看看其他選擇」，也不需要修改後端 action 名稱。

介面語言可以調整，後端 protocol 不必跟著晃動。

---

## 🏆 第一篇總結：先把按鈕當成協議，不只是畫面元件

今天 Codex 還沒有開始處理 Firestore，也還沒有寫完整 handler，但第一步已經確定幾件重要的事：

- 只有需要後端繼續處理的操作才使用 Postback
- Postback 不負責保存上一輪狀態
- Data 只放版本、action 與 session ID
- Action 必須使用白名單
- 使用者文案與後端指令分開

如果一開始就請 Codex「幫我加兩顆按鈕」，畫面可能很快完成，但後面很容易為了補狀態而重做。

這次 Codex 先把按鈕視為一份前後端協議，再開始碰實作。對我來說，這比先看到畫面更有價值。

下一篇會接著處理按鈕背後的記憶：為什麼選 Firestore、session 要保存哪些資料，以及如何處理過期、權限與連點。

---

### 📂 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
