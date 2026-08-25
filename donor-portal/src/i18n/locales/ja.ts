import type { TranslationKey } from '../t';

export const ja: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'SVBC寄付者ポータル',
  'languagePicker.label': '言語',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': 'ログイン',
  'title.checkEmail': 'メールをご確認ください',
  'title.error': 'エラーが発生しました',
  'title.portal': '寄付者ポータル',
  'title.lettersList': '税務書類',
  'title.changeRequest': '変更のリクエスト',
  'title.card': '会員証',
  'title.verify': '会員資格の確認',

  // Login
  'login.prompt': 'ログインリンクを受け取るには、メールアドレスを入力してください。',
  'login.submit': 'ログインリンクを送信',

  // Check email
  'checkEmail.heading': 'メールをご確認ください',
  'checkEmail.body': 'メールをご確認ください。ご登録のメールアドレスであれば、まもなくログインリンクが届きます。このリンクは有効期限が短く、1回のみご利用いただけます。',

  // Error page + route-level error messages
  'error.heading': 'エラーが発生しました',
  'error.requestNewLink': '新しいログインリンクをリクエスト',
  'error.invalidLink': 'このリンクは無効です。新しいリンクをリクエストしてください。',
  'error.expiredLink': 'このリンクの有効期限が切れているか、すでに使用されています。新しいリンクをリクエストしてください。',
  'error.lettersLoadFailed': '現在、お客様の書類を読み込めませんでした。数分後に再度お試しください。',
  'error.letterNotFound': 'その書類は存在しません。',
  'error.letterLoadFailed': '現在、お客様の書類を読み込めませんでした。数分後に再度お試しください。',
  'error.rateLimited': 'リクエストが多すぎます。しばらくしてから再度お試しください。',
  'error.cardNotFound': 'その会員証は存在しません。',
  'error.cardLoadFailed': '現在、お客様の会員証を読み込めませんでした。数分後に再度お試しください。',
  'error.cardRegenerateFailed': '現在、会員証を再発行できませんでした。数分後に再度お試しください。',
  'error.verifyLoadFailed': '現在、この会員証を確認できませんでした。数分後に再度お試しください。',
  'error.generic': 'エラーが発生しました。もう一度ログインしてください。',

  // Portal
  'portal.heading': '寄付者ポータル',
  'portal.membership': '会員資格: {{status}}（{{tier}}）',
  'portal.totalDonated': '寄付合計額: {{total}}',
  'portal.membershipCardLink': '会員証',
  'portal.tableDate': '日付',
  'portal.tableAmount': '金額',
  'portal.tableDescription': '内容',
  'portal.discountsHeading': '自転車店の割引',
  'portal.taxDocumentsLink': '税務書類',
  'portal.changeRequestLink': '登録情報の変更をリクエスト',
  'portal.logout': 'ログアウト',

  // Letters
  'letters.listHeading': '税務書類',
  'letters.listIntro': '各書類は、その暦年に記録されている寄付をまとめた証明書です。書類を開き、ブラウザの印刷機能を使って印刷するか、PDFとして保存してください。',
  'letters.noneYet': '{{name}} 様がご利用いただける書類はまだありません。書類は、少なくとも1件の寄付があった完了済みの暦年を対象としています。',
  'letters.yearLink': '{{year}}年分の税務書類',
  'letters.backToPortal': 'ポータルに戻る',
  'letters.unavailable': '年末の税務書類はまだご利用いただけません。しばらくしてから再度ご確認いただくか、それまでに寄付の概要が必要な場合はお問い合わせください。',
  'letters.backToLetters': '税務書類に戻る',
  'letters.print': '印刷またはPDFとして保存',
  'letters.englishOnlyNote': 'この公式書類は英語で発行されます。',

  // Change request
  'changeRequest.formHeading': '登録情報の変更をリクエスト',
  'changeRequest.formIntro': '以下に新しい情報を入力して送信してください。SVBCのスタッフがすべてのリクエストを確認したうえで反映します。反映され次第、更新内容が表示されます。',
  'changeRequest.currentDetailsHeading': '{{name}} 様 — 現在の登録情報',
  'changeRequest.fieldAddress': '住所',
  'changeRequest.fieldEmail': 'メールアドレス',
  'changeRequest.fieldPhone': '電話番号',
  'changeRequest.fieldLanguage': '希望言語',
  'changeRequest.whoseRecord': 'どなたの登録情報か',
  'changeRequest.whatToChange': '変更する項目',
  'changeRequest.newValue': '新しい情報',
  'changeRequest.submit': '確認のため送信',
  'changeRequest.emailNote': 'メールアドレスの変更は、スタッフが反映した時点でポータルへのログインに適用されます。',
  'changeRequest.submittedHeading': 'リクエストを受け付けました',
  'changeRequest.submittedBody': 'ありがとうございます。SVBCのスタッフがリクエストを確認し、変更を反映します。通常、数営業日ほどかかります。',
  'changeRequest.duplicateHeading': '送信済みです',
  'changeRequest.duplicateBody': '同じ内容のリクエストはすでに登録されています。スタッフが対応いたしますので、再度送信いただく必要はありません。',
  'changeRequest.invalidHeading': '修正が必要な項目があります',
  'changeRequest.backToForm': 'フォームに戻る',
  'changeRequest.unavailableHeading': '変更のリクエスト',
  'changeRequest.unavailableBody': 'セルフサービスでの変更リクエストはまだご利用いただけません。SVBCまでお問い合わせいただければ、代わりに登録情報を更新いたします。',

  // Membership card + public verify page
  'card.heading': '会員証',
  'card.tier': '会員ランク: {{tier}}',
  'card.status': 'ステータス: {{status}}',
  'card.expires': '有効期限: {{expiry}}',
  'card.scanHint': 'この会員証を提示するか、店舗にQRコードをスキャンしてもらうか、上のリンクを開いてもらうことで、会員資格を確認できます。',
  'card.regenerate': '会員証を再発行',
  'card.regenerateHint': '再発行すると、古いQRコードとリンクはすぐに無効になります。会員証のリンクが漏えいした可能性がある場合にご利用ください。',
  'card.unavailable': 'デジタル会員証はまだご利用いただけません。しばらくしてから再度ご確認ください。',
  'verify.heading': '会員資格の確認',
  'verify.disclaimer': 'この情報は当団体の記録からリアルタイムで取得されています。',
  'verify.notValid': 'この会員証は無効です。再発行されたか、すでに有効でなくなっている可能性があります。',

  // Login email (src/email/resend.ts)
  'email.subject': 'SVBC寄付者ポータルへのログインリンク',
  'email.bodyIntro': '下のボタンをクリックして寄付者ポータルにログインしてください。このリンクは有効期限が短く、1回のみご利用いただけます。',
  'email.loginButton': 'ログイン',

  // Pledges + employer matching gifts
  'title.pledges': 'ご寄付の誓約',
  'title.matchingGifts': 'マッチングギフト',
  'error.pledgesLoadFailed': '現在、誓約情報を読み込めません。数分後にもう一度お試しください。',
  'portal.pledgesLink': 'ご寄付の誓約',
  'portal.matchingGiftsLink': '勤務先のマッチングギフト',
  'pledges.heading': 'ご寄付の誓約',
  'pledges.intro': '記録されている誓約とその進捗は以下のとおりです。相違がある場合は SVBC までご連絡ください。',
  'pledges.noneYet': '{{name}} さんの誓約は登録されていません。',
  'pledges.tablePledge': '誓約',
  'pledges.tablePledged': '誓約額',
  'pledges.tableFulfilled': '達成額',
  'pledges.tableProgress': '進捗',
  'pledges.tableStatus': 'ステータス',
  'pledges.tableDue': '期日',
  'pledges.unavailable': '誓約の確認機能はまだご利用いただけません。後日改めてご確認いただくか、誓約についてのご質問は SVBC までお問い合わせください。',
  'matchingGifts.heading': '勤務先のマッチングギフト',
  'matchingGifts.intro': '多くの企業では、従業員の慈善寄付と同額を上乗せするマッチングギフト制度があります。追加のご負担なく、SVBC への寄付が倍になることもあります。',
  'matchingGifts.howTo': '勤務先の人事・給与担当部署にマッチングギフト制度の有無を確認し、その手続きに沿って SVBC への寄付を申請してください。',
  'matchingGifts.einLine': '申請フォームには当団体の税務番号(EIN)が必要な場合があります: {{ein}}',
  'matchingGifts.searchHint': '下の検索で勤務先のマッチングギフト制度と申請方法をご確認ください。',
  'matchingGifts.searchUnavailable': '勤務先検索は設定が完了次第ここに表示されます。それまでは、人事・給与担当部署に寄付がマッチング対象かどうかをご確認ください。',
} satisfies Record<TranslationKey, string>;
