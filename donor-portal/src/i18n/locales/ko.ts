import type { TranslationKey } from '../t';

export const ko: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'SVBC 기부자 포털',
  'languagePicker.label': '언어',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': '로그인',
  'title.checkEmail': '이메일을 확인해 주세요',
  'title.error': '문제가 발생했습니다',
  'title.portal': '기부자 포털',
  'title.lettersList': '세금 서류',
  'title.changeRequest': '변경 요청',
  'title.card': '회원 카드',
  'title.verify': '회원 자격 확인',

  // Login
  'login.prompt': '로그인 링크를 받으시려면 이메일 주소를 입력해 주세요.',
  'login.submit': '로그인 링크 보내기',

  // Check email
  'checkEmail.heading': '이메일을 확인해 주세요',
  'checkEmail.body': '이메일을 확인해 주세요. 등록된 주소인 경우 로그인 링크가 곧 도착합니다. 이 링크는 유효기간이 짧고 한 번만 사용할 수 있습니다.',

  // Error page + route-level error messages
  'error.heading': '문제가 발생했습니다',
  'error.requestNewLink': '새 로그인 링크 요청',
  'error.invalidLink': '이 링크는 유효하지 않습니다. 새 링크를 요청해 주세요.',
  'error.expiredLink': '이 링크는 만료되었거나 이미 사용되었습니다. 새 링크를 요청해 주세요.',
  'error.lettersLoadFailed': '지금은 편지를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.',
  'error.letterNotFound': '해당 편지가 존재하지 않습니다.',
  'error.letterLoadFailed': '지금은 편지를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.',
  'error.rateLimited': '요청이 너무 많습니다 — 잠시 후 다시 시도해 주세요.',
  'error.cardNotFound': '해당 카드가 존재하지 않습니다.',
  'error.cardLoadFailed': '지금은 카드를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.',
  'error.cardRegenerateFailed': '지금은 카드를 재발급할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  'error.verifyLoadFailed': '지금은 이 카드를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  'error.generic': '문제가 발생했습니다. 다시 로그인해 주세요.',

  // Portal
  'portal.heading': '기부자 포털',
  'portal.membership': '회원 자격: {{status}} ({{tier}})',
  'portal.totalDonated': '총 기부금: {{total}}',
  'portal.membershipCardLink': '회원 카드',
  'portal.tableDate': '날짜',
  'portal.tableAmount': '금액',
  'portal.tableDescription': '설명',
  'portal.discountsHeading': '자전거 매장 할인',
  'portal.taxDocumentsLink': '세금 서류',
  'portal.changeRequestLink': '정보 변경 요청',
  'portal.logout': '로그아웃',

  // Letters
  'letters.listHeading': '세금 서류',
  'letters.listIntro': '각 편지는 해당 연도에 저희 기록에 남아 있는 기부금을 종합적으로 확인해 드리는 문서입니다. 편지를 연 다음 브라우저의 인쇄 기능을 사용해 인쇄하거나 PDF로 저장하세요.',
  'letters.noneYet': '{{name}}님을 위한 편지가 아직 없습니다 — 편지는 최소 1건 이상의 기부가 있었던, 이미 종료된 연도를 대상으로 발급됩니다.',
  'letters.yearLink': '{{year}}년 세금 편지',
  'letters.backToPortal': '포털로 돌아가기',
  'letters.unavailable': '연말 세금 편지는 아직 제공되지 않습니다. 잠시 후 다시 확인해 주시거나, 그동안 기부 내역 요약이 필요하시면 저희에게 문의해 주세요.',
  'letters.backToLetters': '세금 서류로 돌아가기',
  'letters.print': '인쇄 또는 PDF로 저장',
  'letters.englishOnlyNote': '이 공식 문서는 영어로 발급됩니다.',

  // Change request
  'changeRequest.formHeading': '정보 변경 요청',
  'changeRequest.formIntro': '아래에 새 값을 입력해 제출해 주세요. SVBC 직원이 모든 요청을 검토한 후 적용하며, 처리가 완료되면 변경 내용이 반영됩니다.',
  'changeRequest.currentDetailsHeading': '{{name}}님 — 현재 정보',
  'changeRequest.fieldAddress': '주소',
  'changeRequest.fieldEmail': '이메일',
  'changeRequest.fieldPhone': '전화번호',
  'changeRequest.fieldLanguage': '선호 언어',
  'changeRequest.whoseRecord': '변경 대상',
  'changeRequest.whatToChange': '변경할 항목',
  'changeRequest.newValue': '새 값',
  'changeRequest.submit': '검토 요청 제출',
  'changeRequest.emailNote': '이메일 변경은 직원이 적용한 후 포털 로그인에 반영됩니다.',
  'changeRequest.submittedHeading': '요청이 접수되었습니다',
  'changeRequest.submittedBody': '감사합니다 — SVBC 직원이 요청을 검토한 후 변경 사항을 적용합니다. 보통 며칠(영업일 기준)이 소요됩니다.',
  'changeRequest.duplicateHeading': '이미 제출됨',
  'changeRequest.duplicateBody': '동일한 요청이 이미 접수되어 있습니다 — 직원이 곧 처리할 예정입니다. 다시 제출하실 필요는 없습니다.',
  'changeRequest.invalidHeading': '수정이 필요합니다',
  'changeRequest.backToForm': '양식으로 돌아가기',
  'changeRequest.prefsHeading': '{{name}} — 연락 수신 설정',
  'changeRequest.prefsIntro': 'SVBC가 연락하는 방법을 선택하세요. 변경 사항은 직원 검토 후 적용됩니다.',
  'changeRequest.prefEmailOptOut': 'SVBC 이메일',
  'changeRequest.prefSmsOptOut': 'SVBC 문자 메시지(SMS)',
  'changeRequest.prefDoNotMail': 'SVBC 우편물',
  'changeRequest.prefOptOutYes': '수신 거부',
  'changeRequest.prefOptOutNo': '수신 중',
  'changeRequest.prefMailYes': '우편물을 보내지 마세요',
  'changeRequest.prefMailNo': '우편물을 보내도 됩니다',
  'changeRequest.prefsSubmit': '설정 업데이트',
  'changeRequest.prefsNoChangesHeading': '제출할 변경 사항이 없습니다',
  'changeRequest.prefsNoChangesBody': '설정이 이미 저희 기록과 일치합니다.',
  'changeRequest.unavailableHeading': '변경 요청',
  'changeRequest.unavailableBody': '셀프 서비스 변경 요청은 아직 제공되지 않습니다. SVBC에 문의해 주시면 저희가 대신 정보를 변경해 드리겠습니다.',

  // Membership card + public verify page
  'card.heading': '회원 카드',
  'card.tier': '등급: {{tier}}',
  'card.status': '상태: {{status}}',
  'card.expires': '만료일: {{expiry}}',
  'card.scanHint': '회원 자격을 확인하려면 이 카드를 제시하거나 매장 직원이 QR코드를 스캔하게 하거나 위 링크를 열어 주세요.',
  'card.regenerate': '카드 재발급',
  'card.regenerateHint': '재발급하면 이전 QR코드와 링크가 즉시 무효화됩니다 — 카드 링크가 유출되었다고 생각되는 경우 이 기능을 사용하세요.',
  'card.unavailable': '디지털 회원 카드는 아직 제공되지 않습니다. 잠시 후 다시 확인해 주세요.',
  'verify.heading': '회원 자격 확인',
  'verify.disclaimer': '이 정보는 저희 기록에서 실시간으로 불러온 것입니다.',
  'verify.notValid': '이 카드는 유효하지 않습니다. 재발급되었거나 더 이상 활성 상태가 아닐 수 있습니다.',

  // Login email (src/email/resend.ts)
  'email.subject': 'SVBC 기부자 포털 로그인 링크',
  'email.bodyIntro': '아래 버튼을 클릭해 기부자 포털에 로그인하세요. 이 링크는 유효기간이 짧고 한 번만 사용할 수 있습니다.',
  'email.loginButton': '로그인',
} satisfies Record<TranslationKey, string>;
