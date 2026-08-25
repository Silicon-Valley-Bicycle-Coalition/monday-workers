import type { TranslationKey } from '../t';

export const fil: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'SVBC Donor Portal',
  'languagePicker.label': 'Wika',
  'languagePicker.switch': 'Lumipat',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': 'Mag-log In',
  'title.checkEmail': 'Tingnan ang Iyong Email',
  'title.error': 'May Naganap na Problema',
  'title.portal': 'Ang Iyong Donor Portal',
  'title.lettersList': 'Mga Dokumento sa Buwis',
  'title.changeRequest': 'Humiling ng Pagbabago',
  'title.verify': 'Pagpapatunay ng Membership',

  // Login
  'login.prompt': 'Ilagay ang iyong email para makatanggap ng login link.',
  'login.submit': 'Ipadala ang login link',

  // Check email
  'checkEmail.heading': 'Tingnan ang iyong email',
  'checkEmail.body': 'Pakitingnan ang iyong email: kung nasa records namin ang address na iyon, paparating na ang isang login link. Malapit na itong mag-expire at isang beses lang magagamit.',

  // Error page + route-level error messages
  'error.heading': 'May naganap na problema',
  'error.requestNewLink': 'Humiling ng bagong login link',
  'error.invalidLink': 'Hindi valid ang link na ito. Pakihiling ng bago.',
  'error.expiredLink': 'Nag-expire na o nagamit na ang link na ito. Pakihiling ng bago.',
  'error.lettersLoadFailed': 'Hindi namin ma-load ang iyong mga tax letter sa ngayon. Pakisubukan ulit sa loob ng ilang minuto.',
  'error.letterNotFound': 'Wala pong ganitong tax letter.',
  'error.letterLoadFailed': 'Hindi namin ma-load ang iyong tax letter sa ngayon. Pakisubukan ulit sa loob ng ilang minuto.',
  'error.rateLimited': 'Sobrang dami ng requests — pakisubukan ulit sa loob ng isang minuto.',
  'error.cardNotFound': 'Wala pong ganitong card.',
  'error.cardLoadFailed': 'Hindi namin ma-load ang iyong card sa ngayon. Pakisubukan ulit sa loob ng ilang minuto.',
  'error.cardRegenerateFailed': 'Hindi namin ma-regenerate ang iyong card sa ngayon. Pakisubukan ulit sa loob ng ilang minuto.',
  'error.verifyLoadFailed': 'Hindi namin ma-verify ang card na ito sa ngayon. Pakisubukan ulit sa loob ng ilang minuto.',
  'error.generic': 'May naganap na problema. Pakisubukan mag-log in ulit.',

  // Portal
  'portal.heading': 'Ang iyong donor portal',
  'portal.membership': 'Katayuan ng membership: {{status}} ({{tier}})',
  'portal.totalLabel': 'Kabuuang na-donate',
  'portal.tableDate': 'Petsa',
  'portal.tableAmount': 'Halaga',
  'portal.tableDescription': 'Deskripsyon',
  'portal.discountsHeading': 'Mga diskwento sa bike shop',
  'portal.taxDocumentsLink': 'Mga dokumento sa buwis',
  'portal.changeRequestLink': 'Humiling ng pagbabago sa iyong impormasyon',
  'portal.logout': 'Mag-log out',

  // Letters
  'letters.listHeading': 'Mga dokumento sa buwis',
  'letters.listIntro': 'Bawat tax letter ay isang pinagsama-samang kumpirmasyon ng mga donasyon na nakatala sa records namin para sa taong iyon. Buksan ang isang tax letter at gamitin ang Print option ng iyong browser para i-print ito o i-save bilang PDF.',
  'letters.noneYet': 'Wala pang available na tax letter para kay {{name}} — sinasaklaw ng mga tax letter ang mga natapos nang taon na may kahit isang donasyon.',
  'letters.yearLink': 'Tax letter para sa {{year}}',
  'letters.backToPortal': 'Bumalik sa iyong portal',
  'letters.unavailable': 'Hindi pa available ang year-end tax letters. Pakibalikan ulit sa lalong madaling panahon, o makipag-ugnayan sa amin kung kailangan mo ng giving summary sa ngayon.',
  'letters.backToLetters': 'Bumalik sa mga dokumento sa buwis',
  'letters.print': 'I-print o i-save bilang PDF',
  'letters.englishOnlyNote': 'Ang opisyal na dokumentong ito ay inilalabas sa Ingles.',

  // Change request
  'changeRequest.formHeading': 'Humiling ng pagbabago sa iyong impormasyon',
  'changeRequest.formIntro': 'Isumite ang bagong value sa ibaba. Sinusuri ng SVBC staff ang bawat request bago ito ilapat — makikita mo ang update kapag naproseso na nila ito.',
  'changeRequest.currentDetailsHeading': '{{name}} — kasalukuyang impormasyon',
  'changeRequest.fieldAddress': 'Address',
  'changeRequest.fieldEmail': 'Email',
  'changeRequest.fieldPhone': 'Numero ng Telepono',
  'changeRequest.fieldLanguage': 'Ninanais na Wika',
  'changeRequest.whoseRecord': 'Kaninong record',
  'changeRequest.whatToChange': 'Ano ang babaguhin',
  'changeRequest.newValue': 'Bagong value',
  'changeRequest.submit': 'Isumite para sa review',
  'changeRequest.emailNote': 'Magkakabisa ang pagbabago ng email para sa portal login kapag inilapat na ito ng staff.',
  'changeRequest.submittedHeading': 'Natanggap ang request',
  'changeRequest.submittedBody': 'Salamat — susuriin ng SVBC staff ang iyong request at ilalapat ang pagbabago. Karaniwang ilang business days ang tinatagal nito.',
  'changeRequest.duplicateHeading': 'Naisumite na',
  'changeRequest.duplicateBody': 'Nasa records na namin ang eksaktong request na ito — aasikasuhin ito ng staff sa lalong madaling panahon. Hindi na kailangang isumite ulit.',
  'changeRequest.invalidHeading': 'May kailangang ayusin',
  'changeRequest.backToForm': 'Bumalik sa form',
  'changeRequest.unavailableHeading': 'Humiling ng pagbabago',
  'changeRequest.unavailableBody': 'Hindi pa available ang self-service change requests. Makipag-ugnayan sa SVBC at kami na ang mag-a-update ng iyong impormasyon.',

  // Membership card + public verify page
  'card.tier': 'Antas: {{tier}}',
  'card.status': 'Katayuan: {{status}}',
  'card.expires': 'Mag-e-expire: {{expiry}}',
  'card.expiresLabel': 'Mag-e-expire',
  'card.regenerate': 'I-regenerate ang card',
  'card.qrAlt': 'QR code para i-verify ang membership',
  'verify.heading': 'Pagpapatunay ng membership',
  'verify.disclaimer': 'Kinukuha nang live ang impormasyong ito mula sa aming records.',
  'verify.notValid': 'Hindi valid ang card na ito. Maaaring na-regenerate na ito o hindi na active.',

  // Login email (src/email/resend.ts)
  'email.subject': 'Ang login link mo para sa SVBC donor portal',
  'email.bodyIntro': 'I-click sa ibaba para mag-log in sa donor portal. Malapit na mag-expire ang link na ito at isang beses lang magagamit.',
  'email.loginButton': 'Mag-log in',
} satisfies Record<TranslationKey, string>;
