import type { TranslationKey } from '../t';

export const zhHant: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'SVBC 捐款者入口網站',
  'languagePicker.label': '語言',
  'languagePicker.switch': '切換',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': '登入',
  'title.checkEmail': '請查收電郵',
  'title.error': '發生問題',
  'title.portal': '您的捐款者入口網站',
  'title.lettersList': '稅務文件',
  'title.changeRequest': '申請變更',
  'title.verify': '會員驗證',

  // Login
  'login.prompt': '請輸入您的電郵地址以接收登入連結。',
  'login.submit': '傳送登入連結',

  // Check email
  'checkEmail.heading': '請查收電郵',
  'checkEmail.body': '請查收您的電郵：如該地址在我們的記錄中，登入連結即將寄出。連結將於短時間內失效，且只能使用一次。',

  // Error page + route-level error messages
  'error.heading': '發生問題',
  'error.requestNewLink': '申請新的登入連結',
  'error.invalidLink': '此連結無效，請申請新的連結。',
  'error.expiredLink': '此連結已過期或已被使用，請申請新的連結。',
  'error.lettersLoadFailed': '我們目前無法載入您的信函，請稍後幾分鐘再試。',
  'error.letterNotFound': '找不到此信函。',
  'error.letterLoadFailed': '我們目前無法載入您的信函，請稍後幾分鐘再試。',
  'error.rateLimited': '請求次數過多，請稍後一分鐘再試。',
  'error.cardNotFound': '找不到此卡片。',
  'error.cardLoadFailed': '我們目前無法載入您的會員卡，請稍後幾分鐘再試。',
  'error.cardRegenerateFailed': '我們目前無法重新產生您的會員卡，請稍後幾分鐘再試。',
  'error.verifyLoadFailed': '我們目前無法驗證此卡片，請稍後幾分鐘再試。',
  'error.generic': '發生問題，請重新登入。',

  // Portal
  'portal.heading': '您的捐款者入口網站',
  'portal.membership': '會員狀態：{{status}}（{{tier}}）',
  'portal.totalLabel': '捐款總額',
  'portal.tableDate': '日期',
  'portal.tableAmount': '金額',
  'portal.tableDescription': '說明',
  'portal.discountsHeading': '單車店優惠',
  'portal.taxDocumentsLink': '稅務文件',
  'portal.changeRequestLink': '申請變更您的資料',
  'portal.logout': '登出',

  // Letters
  'letters.listHeading': '稅務文件',
  'letters.listIntro': '每封信函都是我們記錄中該曆年捐款的彙總證明。開啟信函後，可使用瀏覽器的「列印」功能將其列印或另存為 PDF。',
  'letters.noneYet': '目前尚無 {{name}} 的可用信函 — 信函僅涵蓋已結束且至少有一筆捐款的曆年。',
  'letters.yearLink': '{{year}} 年度稅務信函',
  'letters.backToPortal': '返回您的入口網站',
  'letters.unavailable': '年度稅務信函暫未提供，請稍後再查看；如您現在需要捐款彙總，也歡迎與我們聯絡。',
  'letters.backToLetters': '返回稅務文件',
  'letters.print': '列印或另存為 PDF',
  'letters.englishOnlyNote': '本正式文件以英文發出。',

  // Change request
  'changeRequest.formHeading': '申請變更您的資料',
  'changeRequest.formIntro': '請在下方提交新的資料。SVBC 工作人員會先審核每項申請才予以套用 — 處理完成後您即可看到更新。',
  'changeRequest.currentDetailsHeading': '{{name}} — 目前資料',
  'changeRequest.fieldAddress': '地址',
  'changeRequest.fieldEmail': '電郵',
  'changeRequest.fieldPhone': '電話',
  'changeRequest.fieldLanguage': '偏好語言',
  'changeRequest.whoseRecord': '所屬記錄',
  'changeRequest.whatToChange': '要變更的項目',
  'changeRequest.newValue': '新的值',
  'changeRequest.submit': '提交審核',
  'changeRequest.emailNote': '電郵變更須經工作人員套用後，才會用於入口網站登入。',
  'changeRequest.submittedHeading': '已收到申請',
  'changeRequest.submittedBody': '謝謝 — SVBC 工作人員將審核您的申請並進行變更，通常需時數個工作天。',
  'changeRequest.duplicateHeading': '已提交過此申請',
  'changeRequest.duplicateBody': '我們已收到完全相同的申請，工作人員將盡快處理，無需再次提交。',
  'changeRequest.invalidHeading': '有資料需要修正',
  'changeRequest.backToForm': '返回表單',
  'changeRequest.unavailableHeading': '申請變更',
  'changeRequest.unavailableBody': '自助變更申請功能暫未提供，請與 SVBC 聯絡，我們將為您更新資料。',

  // Membership card + public verify page
  'card.tier': '等級：{{tier}}',
  'card.status': '狀態：{{status}}',
  'card.expires': '有效期至：{{expiry}}',
  'card.expiresLabel': '到期',
  'card.regenerate': '重新產生會員卡',
  'card.qrAlt': '用於驗證會員身份的 QR 碼',
  'verify.heading': '會員驗證',
  'verify.disclaimer': '此資訊為即時從我們的記錄中擷取。',
  'verify.notValid': '此卡片無效，可能已重新產生或已不再生效。',

  // Login email (src/email/resend.ts)
  'email.subject': '您的 SVBC 捐款者入口網站登入連結',
  'email.bodyIntro': '請按下方按鈕登入捐款者入口網站。此連結將於短時間內失效，且只能使用一次。',
  'email.loginButton': '登入',
} satisfies Record<TranslationKey, string>;
