# 新版 LINE Bot 怎麼安全上線？我替 Webhook 留了一條回頭路

Postback 功能在本機完成，也通過測試了。接下來只剩部署。

但這次我不想直接蓋掉原本正在使用的 Zona Cafe。新版如果哪裡沒設好，使用者連舊功能都會一起失去。

所以我和 Codex 這次做的，不只是把程式部署到 Cloud Run，而是先留好一條回頭路：舊服務繼續運作，新服務平行上線；確認新服務正常後才切換 LINE Webhook，失敗就立刻換回舊網址。

---

## 不直接改舊服務，先讓新舊版本並存

這次的 Postback 功能放在新的 repo 和 Cloud Run service：

```text
舊服務：line-map-grounding
新服務：codex-postback-action
```

舊服務保持不動，繼續當作目前已知可用的版本。新服務則可以先部署、檢查和修正，不會立刻影響 LINE 使用者。

這不是打算長期維護兩套 Bot，而是讓發布當下有兩個清楚的選項：新版沒問題就切過去；有問題就回到舊版。

Postback 新增了 Firestore session，因此新服務也使用自己的 runtime service account，只拿 Vertex AI、Firestore 與服務用量所需的權限。

分開身分的好處很實際：看到 audit log 時，能知道是哪個版本在操作；如果新版真的有問題，也能單獨停用它，不影響舊服務。

---

## 部署完成，不代表可以立刻接正式流量

Cloud Run 顯示部署成功後，我們沒有馬上修改 LINE 設定，而是先確認：

- 新 revision 已經正常接收流量
- `/health` 可以打開
- 啟動 logs 沒有明顯錯誤
- Firestore 和必要 API 都準備好了
- 舊服務網址仍然可用

這些檢查不能代替手機實測，但可以先擋掉容器起不來、環境變數漏設或網址寫錯等問題。

我以前很容易把「部署指令跑完」當成上線完成。這次比較像是把部署與正式切換分成兩個階段：服務先站穩，再讓使用者進來。

---

## 切換前，先把現在的 Webhook 網址記下來

真正修改 Webhook 前，Codex 先透過 LINE API 讀取目前使用中的 endpoint，而不是靠我手動貼一個印象中的舊網址。

原因很簡單：正式設定可能曾經被改過。真正能回去的地方，應該以 LINE 當下的設定為準。

接著流程是：

```text
讀取目前的舊 endpoint
  → 設定新的 endpoint
  → 執行 LINE Webhook Verify
  → 成功就保留新版
  → 失敗就切回舊版
```

概念程式如下：

```typescript
const oldEndpoint = await getCurrentWebhook();

try {
  await setWebhook(newEndpoint);
  const result = await testWebhook(newEndpoint);

  if (!result.success) {
    await setWebhook(oldEndpoint);
  }
} catch {
  await setWebhook(oldEndpoint);
}
```

這次 Verify 回傳 `200 OK`，新服務 logs 也沒有 error，Webhook 才正式留在新網址。

真正讓我安心的不是 Verify 成功，而是失敗時該做什麼，早在切換前就已經寫好了。

---

## 有些背景工作還沒完成，不代表要整個回復

部署當下，Firestore TTL 還顯示為 `PROCESSING`。

第一眼看到這個狀態，很容易覺得是不是不該切換。但 session 是否過期，本來就是由程式即時檢查；TTL 只負責稍後清除舊資料，不會影響使用者能不能按「換一批」。

所以我們沒有因為 TTL 還在背景處理就回復舊版。

這件事也提醒我，可回復發布不是看到任何非同步狀態就緊張，而是要先分清楚：它會不會真的影響現在的使用者？

---

## 最後還是要回到手機上按一次

Cloud Run health 和 Webhook Verify 只能證明 LINE 找得到服務，不會替使用者操作 Postback。

最後我還是拿起手機，完整走一次：

1. 傳送位置並取得咖啡廳推薦
2. 點「換一批」，確認出現其他選擇
3. 點「更適合工作」
4. 確認過期或連點時，Bot 會給出合理提示

這條路徑真的走完，新版才算上線。

---

## 第三篇小結

這次發布做的事情並不花俏：

- 保留原本可用的服務
- 平行部署新版
- 切換前先做健康檢查
- 從 LINE 讀取真正的舊 endpoint
- 更新後立刻 Verify
- 失敗就自動切回舊網址
- 最後用手機走完整流程

這些步驟不會讓「換一批」按鈕更漂亮，卻能避免新功能上線時，把原本正常的 Bot 一起拖下水。

我這次最想留下的一句話是：

> 發布不是把新版推上去，而是先知道出問題時要怎麼安全地回來。

---

### 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
