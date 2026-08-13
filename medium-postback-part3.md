# 「換一批」怎麼真的換？我和 Codex 實作 LINE Postback Handler 與測試

前兩篇，我和 Codex 已經決定 Postback data 格式，也設計好 Firestore 搜尋 session。

這一篇只看程式如何把兩者接起來：收到 Postback event、找回狀態、改變搜尋條件、組出 Quick Reply，並測試這些可控制的邊界。

Google Maps Grounding 本身怎麼查、Loading Animation 怎麼顯示，之前已經寫過，這裡不再重複。

---

## 🧩 Codex 先把 Postback 從 Message 流程分流

原本 handler 主要處理文字與位置。加入 Postback 後，Codex 在事件入口先判斷：

```typescript
if (event.type === 'postback') {
  await handlePostbackEvent(event);
  return;
}

if (event.type !== 'message') {
  return;
}
```

新的 `postbackHandler.ts` 負責：

1. 解析 Postback data
2. 驗證 action 與 session
3. 取得 Firestore 處理鎖
4. 組合搜尋條件
5. 更新 session
6. 推送新結果

Codex 沒把這些判斷塞進原本 location handler。第一次搜尋與沿用狀態再搜尋是兩條不同流程，分開後比較容易繼續增加新 action。

---

## 🧾 外部字串先經過 Parser，再進入 Handler

Codex 建立專用 parser，將：

```text
v=1&a=reroll&s=abc123
```

轉成程式內明確型別：

```typescript
type ParsedCafePostback = {
  action: 'reroll' | 'work_friendly';
  sessionId: string;
};
```

Parser 會拒絕錯誤版本、未知 action、缺少 session ID，以及含有不合法字元的 ID。

Firestore path 與搜尋邏輯因此不會直接接觸未驗證輸入。

Codex 把 parser 獨立出來，也讓 protocol 可以單獨測試，不需要真的連 LINE 或 Firestore 才知道解析是否正確。

---

## 🔄 「換一批」不是再呼叫一次相同搜尋

如果座標與 prompt 完全一樣，模型很可能仍然推薦原本最熱門的店。

所以每次搜尋成功後，Codex 會將新一批店名寫回 `previousCafeNames`。

下一次操作時：

```typescript
const result = await findNearbyCafes(
  session.latitude,
  session.longitude,
  {
    preference,
    excludeNames: session.previousCafeNames
  }
);
```

Prompt 的要求是「有其他合理選擇時，優先避開上一批」，而不是無條件禁止。

因為某些地點附近選擇本來就少。Codex 不希望模型為了硬湊不同店家，把搜尋範圍拉得不合理。

---

## 💻 工作偏好會留在同一個 Session 裡

使用者點「更適合工作」後，Codex 將 preference 改成 `work_friendly`。

後續再按「換一批」，這個偏好仍然保留，不會突然回到預設模式。

工作偏好只會要求模型優先採用有明確 Maps 證據、適合坐下或使用筆電的店家。

沒有證據時，Codex 明確要求模型不能自行補上插座、Wi-Fi、不限時或安靜等資訊。

所以這顆按鈕是搜尋方向，不是設備保證。

---

## 💬 Quick Reply 會依照 Session 是否成功建立而變化

有 session 時，結果包含：

- 換一批：Postback action
- 更適合工作：Postback action
- 重新選位置：Location action

```typescript
{
  type: 'postback',
  label: '換一批',
  displayText: '🔄 換一批咖啡廳',
  data: createCafePostbackData('reroll', sessionId)
}
```

沒有 session 時，Codex 只顯示「重新選位置」。

這讓 UI 直接反映後端目前能提供的能力，不會出現一顆注定失敗的按鈕。

---

## 🧯 不同錯誤，應該告訴使用者不同下一步

Codex 沒有把所有錯誤都變成「請稍後再試」。

- 正在處理：等待上一個結果
- Session 過期：重新傳位置
- Session 屬於其他人：建立自己的搜尋
- Data 無法辨識：重新開始
- 外部搜尋失敗：稍後再試

每個錯誤訊息下方都能重新傳送位置，讓使用者有明確出口。

如果處理途中失敗，Codex 也會嘗試釋放 Firestore 鎖，避免使用者必須等滿 90 秒才能再操作。

---

## 🧪 Codex 測試的是 Protocol，不是某一家咖啡廳

模型推薦會受到位置與即時 Maps 資料影響，不適合把某間店寫死在單元測試裡。

Codex 將測試放在可控制的部分：

### Postback data

- 支援的 action 能正確產生與解析
- 結果沒有超過 300 字元
- 錯誤版本、action 與 session ID 會被拒絕

### LINE 訊息

- 有 session 時出現兩個 Postback 與一個 location action
- 沒有 session 時只出現 location action

### 原本行為

- Google Maps source 去重測試仍然通過
- 全專案 TypeScript 型別檢查通過

最後執行：

```bash
npm run typecheck
npm test
```

5 項測試全部成功。

Codex 沒有假裝單元測試能保證外部資料永遠相同，而是確認我們自己定義的 protocol、訊息結構與 fallback 不會偷偷改變。

---

## 🏆 第三篇總結：把每個不確定性擋在正確邊界

這次實作的主線其實很清楚：

- Webhook 先分流 event type
- Parser 擋住不合法 data
- Firestore session 提供可信任狀態
- 搜尋服務只接收明確 options
- Message builder 依能力產生按鈕
- 測試鎖住 protocol 與 fallback

Codex 沒有用一個巨大 handler 把全部事情做完，而是讓每一層只處理自己能判斷的問題。

完成這一步後，功能在本機已經成立。最後一篇會寫這次真正新的上線經驗：如何保留舊服務、先驗證新服務，再讓 LINE webhook 成功才切換、失敗就自動回復。

---

### 📂 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
