import type { TranslationKey } from '../t';

export const zhHans: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'SVBC 捐赠者门户',
  'languagePicker.label': '语言',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': '登录',
  'title.checkEmail': '请查收邮件',
  'title.error': '出现问题',
  'title.portal': '您的捐赠者门户',
  'title.lettersList': '税务文件',
  'title.changeRequest': '申请变更',
  'title.card': '您的会员卡',
  'title.verify': '会员验证',

  // Login
  'login.prompt': '请输入您的电子邮箱以接收登录链接。',
  'login.submit': '发送登录链接',

  // Check email
  'checkEmail.heading': '请查收邮件',
  'checkEmail.body': '请查收您的电子邮箱：如果该地址在我们的记录中，登录链接即将发送到您的邮箱。链接很快会失效，且只能使用一次。',

  // Error page + route-level error messages
  'error.heading': '出现问题',
  'error.requestNewLink': '申请新的登录链接',
  'error.invalidLink': '此链接无效，请申请一个新链接。',
  'error.expiredLink': '此链接已过期或已被使用，请申请一个新链接。',
  'error.lettersLoadFailed': '我们暂时无法加载您的信函，请几分钟后再试。',
  'error.letterNotFound': '该信函不存在。',
  'error.letterLoadFailed': '我们暂时无法加载您的信函，请几分钟后再试。',
  'error.rateLimited': '请求过于频繁，请稍后再试。',
  'error.cardNotFound': '该卡片不存在。',
  'error.cardLoadFailed': '我们暂时无法加载您的会员卡，请几分钟后再试。',
  'error.cardRegenerateFailed': '我们暂时无法重新生成您的会员卡，请几分钟后再试。',
  'error.verifyLoadFailed': '我们暂时无法验证此卡片，请几分钟后再试。',
  'error.generic': '出现问题，请重新登录。',

  // Portal
  'portal.heading': '您的捐赠者门户',
  'portal.membership': '会员状态：{{status}}（{{tier}}）',
  'portal.totalDonated': '捐款总额：{{total}}',
  'portal.membershipCardLink': '会员卡',
  'portal.tableDate': '日期',
  'portal.tableAmount': '金额',
  'portal.tableDescription': '说明',
  'portal.discountsHeading': '自行车店折扣',
  'portal.taxDocumentsLink': '税务文件',
  'portal.changeRequestLink': '申请变更您的信息',
  'portal.logout': '退出登录',

  // Letters
  'letters.listHeading': '税务文件',
  'letters.listIntro': '每封信函都是我们记录中该日历年度捐款的汇总证明。打开信函后，可使用浏览器的“打印”功能将其打印出来或保存为 PDF。',
  'letters.noneYet': '目前还没有 {{name}} 的可用信函 — 信函仅覆盖已结束且至少有一笔捐款的日历年度。',
  'letters.yearLink': '{{year}} 年度税务信函',
  'letters.backToPortal': '返回您的门户',
  'letters.unavailable': '年度税务信函暂未提供，请稍后再查看；如果您现在需要捐款汇总，也可以联系我们。',
  'letters.backToLetters': '返回税务文件',
  'letters.print': '打印或保存为 PDF',
  'letters.englishOnlyNote': '此正式文件以英文出具。',

  // Change request
  'changeRequest.formHeading': '申请变更您的信息',
  'changeRequest.formIntro': '请在下方提交新的信息。SVBC 工作人员会审核每一项申请后再予以应用 — 处理完成后您将看到更新。',
  'changeRequest.currentDetailsHeading': '{{name}} — 当前信息',
  'changeRequest.fieldAddress': '地址',
  'changeRequest.fieldEmail': '电子邮箱',
  'changeRequest.fieldPhone': '电话',
  'changeRequest.fieldLanguage': '偏好语言',
  'changeRequest.whoseRecord': '所属记录',
  'changeRequest.whatToChange': '要变更的内容',
  'changeRequest.newValue': '新值',
  'changeRequest.submit': '提交审核',
  'changeRequest.emailNote': '工作人员应用后，邮箱变更才会用于门户登录。',
  'changeRequest.submittedHeading': '已收到申请',
  'changeRequest.submittedBody': '谢谢 — SVBC 工作人员将审核您的申请并进行变更，通常需要几个工作日。',
  'changeRequest.duplicateHeading': '已提交过',
  'changeRequest.duplicateBody': '我们已经收到过完全相同的申请，工作人员会尽快处理，无需重复提交。',
  'changeRequest.invalidHeading': '有信息需要修正',
  'changeRequest.backToForm': '返回表单',
  'changeRequest.unavailableHeading': '申请变更',
  'changeRequest.unavailableBody': '自助变更申请功能暂未提供，请联系 SVBC，我们将为您更新信息。',

  // Membership card + public verify page
  'card.heading': '您的会员卡',
  'card.tier': '等级：{{tier}}',
  'card.status': '状态：{{status}}',
  'card.expires': '有效期至：{{expiry}}',
  'card.scanHint': '出示此卡片，或让店家扫描二维码或打开上方链接，即可确认您的会员身份。',
  'card.regenerate': '重新生成会员卡',
  'card.regenerateHint': '重新生成会立即使旧的二维码和链接失效 — 如果您认为会员卡链接已泄露，请使用此功能。',
  'card.unavailable': '电子会员卡功能暂未提供，请稍后再查看。',
  'verify.heading': '会员验证',
  'verify.disclaimer': '此信息为实时从我们的记录中获取。',
  'verify.notValid': '此卡片无效，可能已被重新生成或已不再有效。',

  // Login email (src/email/resend.ts)
  'email.subject': '您的 SVBC 捐赠者门户登录链接',
  'email.bodyIntro': '点击下方链接登录捐赠者门户。此链接很快会失效，且只能使用一次。',
  'email.loginButton': '登录',
} satisfies Record<TranslationKey, string>;
