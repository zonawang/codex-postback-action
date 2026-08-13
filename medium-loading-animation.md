# LINE Bot 查地圖要等 30 秒，怎麼讓使用者不焦慮？我用 Codex 加上 Loading Animation 與 Push Message

大家哈囉！這篇想分享一個看起來很小，實際上非常影響 LINE Bot 體驗的功能：**Loading Animation。**

前面我做了一個會根據使用者位置，透過 Vertex AI Google Maps Grounding 推薦附近咖啡廳的 LINE Bot。

功能本身已經成功，但第一次拿手機測試時，我遇到一個很真實的問題：

> 位置傳出去後，聊天室安靜了二三十秒。

這段時間，使用者完全不知道 Bot 是正在搜尋、網路很慢，還是已經壞掉。

身為開發者，我知道後端正在呼叫 Vertex AI、整理 Google Maps 來源、翻譯成繁體中文；但使用者看不到這些。他只看到自己傳了一個位置，然後什麼事都沒發生。

所以這篇不只會介紹怎麼呼叫 LINE Loading Animation，也會記錄我和 Codex 最後怎麼把整條等待流程改得比較可靠：

- 收到位置後先顯示載入動畫
- 保持 Cloud Run request，讓 AI 工作真的做完
- 使用 Push Message 主動送回結果
- 加入 logs，知道流程卡在哪裡

---

## 😶 最大的問題不是慢，而是「不知道發生什麼事」

Google Maps Grounding 不是一句固定文字回覆。

後端需要做幾件事：

1. 接收 LINE location event
2. 將 latitude / longitude 傳給 Vertex AI
3. 等待 Google Maps Grounding
4. 整理店家與來源
5. 將英文回答翻成繁體中文
6. 組成 LINE Flex Message
7. 將結果送回聊天室

整個流程可能需要 20～40 秒。

如果使用者看到一個明確的「正在處理」，30 秒還算可以接受；但如果畫面完全沒有動靜，5 秒就足以讓人開始重按、重傳位置，甚至直接離開。

Codex 在讀完目前 handler 後，先提出一個最直接的改善：使用 LINE 官方的 `showLoadingAnimation`。

白話來說，就是讓 Bot 在聊天視窗裡先表現出「我正在想、正在找」。

---

## ⏳ Loading Animation 的程式其實很短

真正呼叫動畫只需要：

```typescript
await lineClient.showLoadingAnimation({
  chatId: targetId,
  loadingSeconds: 60
});
```

這裡有兩個重點：

- `chatId`：要在哪個聊天室顯示動畫
- `loadingSeconds`：動畫最多顯示多久

因為 LINE event 可能來自一對一聊天、群組或聊天室，Codex 先用一個 helper 統一取出 `userId`、`groupId` 或 `roomId`。後面的動畫與推送流程只需要使用同一個 `targetId`，不用重複判斷聊天類型。

---

## 🧩 動畫失敗時，不應該讓整個咖啡廳搜尋一起失敗

Loading Animation 是體驗加分，不是主要功能。

如果動畫 API 暫時失敗，我們仍然希望後面的 Maps Grounding 繼續執行。

所以 Codex 沒有把它跟主要搜尋綁死，而是獨立包一層 `try / catch`：

```typescript
if (targetId) {
  try {
    await lineClient.showLoadingAnimation({
      chatId: targetId,
      loadingSeconds: 60
    });
  } catch (error) {
    logger.error('Loading animation failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
```

這個設計很像餐廳的叫號螢幕壞掉了。

螢幕壞掉當然不理想，但廚房不應該因此停止做餐。

動畫失敗就記錄，真正的搜尋仍然繼續。

---

## ⚠️ 只加動畫還不夠，原本真正的問題在 Webhook 生命週期

我們第一次部署時，webhook route 是這樣：

```typescript
res.sendStatus(200);

await Promise.allSettled(
  req.body.events.map(handleWebhookEvent)
);
```

也就是 LINE 一打進來，伺服器立刻回 `200 OK`，然後才在背景呼叫 Vertex AI。

乍看很合理：先趕快告訴 LINE「我收到了」，剩下慢慢處理。

但放到 Cloud Run 上，這種 response 結束後才繼續跑的背景 Promise，不能當成可靠保證。

當時實際看到的現象就是：

- LINE webhook request 是 200
- Cloud Run health 正常
- 使用者卻完全收不到結果

Codex 讀 Cloud Logging 後，把問題比對回 route，最後將順序改成：

```typescript
const results = await Promise.allSettled(
  req.body.events.map(handleWebhookEvent)
);

res.sendStatus(200);
```

用白話說，原本是櫃台先把案件蓋上「已完成」章，再開始工作；修改後則是先把工作做完，再正式結案。

Loading Animation 解決的是「使用者不知道正在等什麼」，保持 request 解決的則是「後端工作到底有沒有可靠做完」。兩件事不能混在一起。

---

## 📤 為什麼結果改用 Push Message？

Maps Grounding 與翻譯需要時間。

如果一直等到最後才使用最初的 reply token，流程會更依賴 token 的有效時間。

所以 Codex 將 location event 的結果改成 Push Message：

```typescript
const result = await findNearbyCafes(latitude, longitude);
const messages = createCafeResultMessages(result);

await lineClient.pushMessage({
  to: targetId,
  messages
});
```

最後的體驗變成：

1. 使用者傳送位置
2. LINE 顯示 Loading Animation
3. 後端查詢 Vertex AI 與 Google Maps
4. Bot 主動推送繁中摘要與地圖卡片

使用者不需要再按任何按鈕，也不需要盯著一個完全靜止的聊天室。

---

## 🔍 Codex 順手補上的另一件事：不要讓成功路徑完全安靜

第一次沒回覆時，我們只能看到 request 200，卻不知道真正的搜尋走到哪裡。

所以 Codex 加入幾個關鍵 logs：

```typescript
logger.info('Cafe search started', {
  webhookEventId: event.webhookEventId
});

logger.info('Cafe search reply sent', {
  webhookEventId: event.webhookEventId,
  sourceCount: result.sources.length,
  elapsedMs: Date.now() - startedAt
});
```

現在遇到問題時，可以直接回答：

- Event 有沒有進來？
- 搜尋有沒有開始？
- 花了多久？
- 找到幾個來源？
- Push Message 是否成功？

Logs 就像沿路留下的腳印。沒有腳印時，只知道旅客沒到終點；有腳印後，才能知道他停在哪一站。

---

## 🧪 我最後怎麼測 Loading Animation？

測試流程很直接：在 LINE 傳送「開始」，點擊「傳送目前位置」，確認位置送出後先出現 Loading Animation。約 20～40 秒後，應收到繁中咖啡廳摘要、Google Maps 來源卡片與查看按鈕。

最後再到 Cloud Logging 確認同一個 event 依序出現：

- `Webhook event received`
- `Cafe search started`
- `Cafe search reply sent`

畫面與 logs 都走完，才算真正完成 end-to-end 測試。

---

## 💡 還有一個正式產品要注意的問題：Webhook 重試

目前版本會保持 request，等 Grounding 完成後才回 200。如果處理時間較長，LINE 平台可能重試 webhook。正式產品應再加入：

- 使用 `webhookEventId` 去重
- 記錄 processing / completed 狀態
- 或將長時間工作交給 Cloud Tasks

這次 MVP 先解決「背景工作沒完成」與「使用者完全看不到等待狀態」。Codex 也清楚留下下一步：正式環境還要處理去重，避免重複查詢與推送。

---

## 🏆 這篇最想留下的心得

Loading Animation 的 code 只有幾行，但它背後其實連著三個不同問題：

- **使用者體驗**：等待時要知道 Bot 正在工作
- **Webhook lifecycle**：不能先結束 response，再期待背景任務一定完成
- **結果傳送方式**：長時間任務適合用 Push Message 與原始 reply token 解耦

這次 Codex 不只是幫我加一個動畫 API。

它先讀現有 handler、比對 Cloud Run logs、找到 200 但沒結果的真正原因，再一起修改 request 順序、Push Message、錯誤處理與成功 logs，最後重新部署請我用手機再測一次。

所以真正讓體驗變好的，不是一個會動的圖示，而是整條等待流程終於對使用者與開發者都變得清楚。

---

### 📂 專案開源與完整程式碼

👉 **GitHub：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**
