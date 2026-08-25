import type { TranslationKey } from '../t';

export const vi: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'Cổng thông tin Nhà tài trợ SVBC',
  'languagePicker.label': 'Ngôn ngữ',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': 'Đăng nhập',
  'title.checkEmail': 'Kiểm tra email của bạn',
  'title.error': 'Đã xảy ra lỗi',
  'title.portal': 'Cổng thông tin nhà tài trợ của bạn',
  'title.lettersList': 'Tài liệu thuế',
  'title.changeRequest': 'Yêu cầu thay đổi',
  'title.card': 'Thẻ thành viên của bạn',
  'title.verify': 'Xác minh tư cách thành viên',

  // Login
  'login.prompt': 'Nhập email của bạn để nhận liên kết đăng nhập.',
  'login.submit': 'Gửi liên kết đăng nhập',

  // Check email
  'checkEmail.heading': 'Kiểm tra email của bạn',
  'checkEmail.body': 'Vui lòng kiểm tra email của bạn: nếu địa chỉ đó có trong hồ sơ của chúng tôi, một liên kết đăng nhập đang được gửi đến. Liên kết sẽ sớm hết hạn và chỉ có thể sử dụng một lần.',

  // Error page + route-level error messages
  'error.heading': 'Đã xảy ra lỗi',
  'error.requestNewLink': 'Yêu cầu liên kết đăng nhập mới',
  'error.invalidLink': 'Liên kết này không hợp lệ. Vui lòng yêu cầu một liên kết mới.',
  'error.expiredLink': 'Liên kết này đã hết hạn hoặc đã được sử dụng. Vui lòng yêu cầu một liên kết mới.',
  'error.lettersLoadFailed': 'Hiện chúng tôi không thể tải thư của bạn. Vui lòng thử lại sau vài phút.',
  'error.letterNotFound': 'Thư đó không tồn tại.',
  'error.letterLoadFailed': 'Hiện chúng tôi không thể tải thư của bạn. Vui lòng thử lại sau vài phút.',
  'error.rateLimited': 'Quá nhiều yêu cầu — vui lòng thử lại sau một phút.',
  'error.cardNotFound': 'Thẻ đó không tồn tại.',
  'error.cardLoadFailed': 'Hiện chúng tôi không thể tải thẻ của bạn. Vui lòng thử lại sau vài phút.',
  'error.cardRegenerateFailed': 'Hiện chúng tôi không thể tạo lại thẻ của bạn. Vui lòng thử lại sau vài phút.',
  'error.verifyLoadFailed': 'Hiện chúng tôi không thể xác minh thẻ này. Vui lòng thử lại sau vài phút.',
  'error.generic': 'Đã xảy ra lỗi. Vui lòng thử đăng nhập lại.',

  // Portal
  'portal.heading': 'Cổng thông tin nhà tài trợ của bạn',
  'portal.membership': 'Tư cách thành viên: {{status}} ({{tier}})',
  'portal.totalDonated': 'Tổng số tiền đã quyên góp: {{total}}',
  'portal.membershipCardLink': 'Thẻ thành viên',
  'portal.tableDate': 'Ngày',
  'portal.tableAmount': 'Số tiền',
  'portal.tableDescription': 'Mô tả',
  'portal.discountsHeading': 'Ưu đãi tại cửa hàng xe đạp',
  'portal.taxDocumentsLink': 'Tài liệu thuế',
  'portal.changeRequestLink': 'Yêu cầu thay đổi thông tin của bạn',
  'portal.logout': 'Đăng xuất',

  // Letters
  'letters.listHeading': 'Tài liệu thuế',
  'letters.listIntro': 'Mỗi thư là bản xác nhận tổng hợp các khoản quyên góp mà hồ sơ của chúng tôi ghi nhận trong năm dương lịch đó. Hãy mở một thư và sử dụng tùy chọn In của trình duyệt để in hoặc lưu dưới dạng PDF.',
  'letters.noneYet': 'Hiện chưa có thư nào dành cho {{name}} — thư chỉ được phát hành cho các năm dương lịch đã kết thúc có ít nhất một khoản quyên góp.',
  'letters.yearLink': 'Thư thuế năm {{year}}',
  'letters.backToPortal': 'Quay lại cổng thông tin của bạn',
  'letters.unavailable': 'Thư thuế cuối năm hiện chưa có sẵn. Vui lòng quay lại kiểm tra sau, hoặc liên hệ với chúng tôi nếu bạn cần bản tóm tắt quyên góp trong thời gian chờ đợi.',
  'letters.backToLetters': 'Quay lại tài liệu thuế',
  'letters.print': 'In hoặc lưu dưới dạng PDF',
  'letters.englishOnlyNote': 'Tài liệu chính thức này được phát hành bằng tiếng Anh.',

  // Change request
  'changeRequest.formHeading': 'Yêu cầu thay đổi thông tin của bạn',
  'changeRequest.formIntro': 'Vui lòng gửi giá trị mới bên dưới. Nhân viên SVBC sẽ xem xét mọi yêu cầu trước khi áp dụng — bạn sẽ thấy thông tin được cập nhật sau khi yêu cầu được xử lý.',
  'changeRequest.currentDetailsHeading': '{{name}} — thông tin hiện tại',
  'changeRequest.fieldAddress': 'Địa chỉ',
  'changeRequest.fieldEmail': 'Email',
  'changeRequest.fieldPhone': 'Số điện thoại',
  'changeRequest.fieldLanguage': 'Ngôn ngữ ưa thích',
  'changeRequest.whoseRecord': 'Hồ sơ của ai',
  'changeRequest.whatToChange': 'Nội dung cần thay đổi',
  'changeRequest.newValue': 'Giá trị mới',
  'changeRequest.submit': 'Gửi để xem xét',
  'changeRequest.emailNote': 'Việc thay đổi email sẽ có hiệu lực cho việc đăng nhập cổng thông tin sau khi nhân viên áp dụng thay đổi.',
  'changeRequest.submittedHeading': 'Đã nhận yêu cầu',
  'changeRequest.submittedBody': 'Cảm ơn bạn — nhân viên SVBC sẽ xem xét yêu cầu của bạn và áp dụng thay đổi. Quá trình này thường mất vài ngày làm việc.',
  'changeRequest.duplicateHeading': 'Đã được gửi trước đó',
  'changeRequest.duplicateBody': 'Chúng tôi đã có đúng yêu cầu này trong hồ sơ — nhân viên sẽ sớm xử lý. Bạn không cần gửi lại.',
  'changeRequest.invalidHeading': 'Có nội dung cần chỉnh sửa',
  'changeRequest.backToForm': 'Quay lại biểu mẫu',
  'changeRequest.unavailableHeading': 'Yêu cầu thay đổi',
  'changeRequest.unavailableBody': 'Tính năng tự yêu cầu thay đổi hiện chưa khả dụng. Vui lòng liên hệ với SVBC và chúng tôi sẽ cập nhật thông tin giúp bạn.',

  // Membership card + public verify page
  'card.heading': 'Thẻ thành viên của bạn',
  'card.tier': 'Hạng: {{tier}}',
  'card.status': 'Trạng thái: {{status}}',
  'card.expires': 'Hết hạn: {{expiry}}',
  'card.scanHint': 'Xuất trình thẻ này, hoặc để cửa hàng quét mã QR hay mở liên kết ở trên, để xác nhận tư cách thành viên của bạn.',
  'card.regenerate': 'Tạo lại thẻ',
  'card.regenerateHint': 'Việc tạo lại thẻ sẽ vô hiệu hóa ngay lập tức mã QR và liên kết cũ — hãy sử dụng tính năng này nếu bạn nghĩ liên kết thẻ của mình đã bị lộ.',
  'card.unavailable': 'Thẻ thành viên điện tử hiện chưa khả dụng. Vui lòng quay lại kiểm tra sau.',
  'verify.heading': 'Xác minh tư cách thành viên',
  'verify.disclaimer': 'Thông tin này được lấy trực tiếp từ hồ sơ của chúng tôi theo thời gian thực.',
  'verify.notValid': 'Thẻ này không hợp lệ. Thẻ có thể đã được tạo lại hoặc không còn hoạt động.',

  // Login email (src/email/resend.ts)
  'email.subject': 'Liên kết đăng nhập cổng thông tin nhà tài trợ SVBC của bạn',
  'email.bodyIntro': 'Nhấp vào bên dưới để đăng nhập vào cổng thông tin nhà tài trợ. Liên kết này sẽ sớm hết hạn và chỉ có thể sử dụng một lần.',
  'email.loginButton': 'Đăng nhập',
} satisfies Record<TranslationKey, string>;
