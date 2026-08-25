import type { TranslationKey } from '../t';

export const es: Record<TranslationKey, string> = {
  // Site-wide
  'site.title': 'Portal de Donantes de SVBC',
  'languagePicker.label': 'Idioma',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': 'Iniciar sesión',
  'title.checkEmail': 'Revisa tu correo',
  'title.error': 'Algo salió mal',
  'title.portal': 'Tu portal de donante',
  'title.lettersList': 'Documentos fiscales',
  'title.changeRequest': 'Solicitar un cambio',
  'title.card': 'Tu tarjeta de membresía',
  'title.verify': 'Verificación de membresía',
  'title.events': 'Tus inscripciones a eventos',

  // Login
  'login.prompt': 'Ingresa tu correo electrónico para recibir un enlace de acceso.',
  'login.submit': 'Enviar enlace de acceso',

  // Check email
  'checkEmail.heading': 'Revisa tu correo',
  'checkEmail.body': 'Revisa tu correo electrónico: si esa dirección está registrada, un enlace de acceso está en camino. Caduca pronto y solo se puede usar una vez.',

  // Error page + route-level error messages
  'error.heading': 'Algo salió mal',
  'error.requestNewLink': 'Solicitar un nuevo enlace de acceso',
  'error.invalidLink': 'Este enlace no es válido. Por favor solicita uno nuevo.',
  'error.expiredLink': 'Este enlace ha caducado o ya fue usado. Por favor solicita uno nuevo.',
  'error.lettersLoadFailed': 'No pudimos cargar tus cartas en este momento. Por favor intenta de nuevo en unos minutos.',
  'error.letterNotFound': 'Esa carta no existe.',
  'error.letterLoadFailed': 'No pudimos cargar tu carta en este momento. Por favor intenta de nuevo en unos minutos.',
  'error.rateLimited': 'Demasiadas solicitudes — por favor intenta de nuevo en un minuto.',
  'error.cardNotFound': 'Esa tarjeta no existe.',
  'error.cardLoadFailed': 'No pudimos cargar tu tarjeta en este momento. Por favor intenta de nuevo en unos minutos.',
  'error.cardRegenerateFailed': 'No pudimos regenerar tu tarjeta en este momento. Por favor intenta de nuevo en unos minutos.',
  'error.verifyLoadFailed': 'No pudimos verificar esta tarjeta en este momento. Por favor intenta de nuevo en unos minutos.',
  'error.eventsLoadFailed': 'No pudimos cargar tus inscripciones a eventos en este momento. Por favor intenta de nuevo en unos minutos.',
  'error.generic': 'Algo salió mal. Por favor intenta iniciar sesión de nuevo.',

  // Portal
  'portal.heading': 'Tu portal de donante',
  'portal.membership': 'Membresía: {{status}} ({{tier}})',
  'portal.totalDonated': 'Total donado: {{total}}',
  'portal.membershipCardLink': 'Tarjeta de membresía',
  'portal.tableDate': 'Fecha',
  'portal.tableAmount': 'Monto',
  'portal.tableDescription': 'Descripción',
  'portal.discountsHeading': 'Descuentos en tiendas de bicicletas',
  'portal.taxDocumentsLink': 'Documentos fiscales',
  'portal.eventsLink': 'Inscripciones a eventos',
  'portal.changeRequestLink': 'Solicitar un cambio a tus datos',
  'portal.logout': 'Cerrar sesión',

  // Letters
  'letters.listHeading': 'Documentos fiscales',
  'letters.listIntro': 'Cada carta es un comprobante consolidado de las donaciones que nuestros registros muestran para ese año calendario. Abre una carta y usa la opción de Imprimir de tu navegador para imprimirla o guardarla como PDF.',
  'letters.noneYet': 'Aún no hay cartas disponibles para {{name}} — las cartas cubren años calendario completos con al menos una donación.',
  'letters.yearLink': 'Carta fiscal de {{year}}',
  'letters.backToPortal': 'Volver a tu portal',
  'letters.unavailable': 'Las cartas fiscales de fin de año aún no están disponibles. Por favor vuelve a consultar pronto, o contáctanos si necesitas un resumen de donaciones mientras tanto.',
  'letters.backToLetters': 'Volver a los documentos fiscales',
  'letters.print': 'Imprimir o guardar como PDF',
  'letters.englishOnlyNote': 'Este documento oficial se emite en inglés.',

  // Event registrations
  'events.listHeading': 'Tus inscripciones a eventos',
  'events.upcomingHeading': 'Próximos',
  'events.pastHeading': 'Pasados',
  'events.noneYet': 'Aún no hay inscripciones a eventos registradas para {{name}}.',
  'events.tableEvent': 'Evento',
  'events.tableDate': 'Fecha',
  'events.tableStatus': 'Estado',
  'events.statusAttended': 'Asistió',
  'events.statusRegistered': 'Inscrito',
  'events.backToPortal': 'Volver a tu portal',
  'events.unavailable': 'Las inscripciones a eventos aún no están disponibles en el portal. Por favor vuelve pronto.',

  // Change request
  'changeRequest.formHeading': 'Solicitar un cambio a tus datos',
  'changeRequest.formIntro': 'Envía el nuevo valor a continuación. El personal de SVBC revisa cada solicitud antes de aplicarla — verás la actualización una vez que la hayan procesado.',
  'changeRequest.currentDetailsHeading': '{{name}} — datos actuales',
  'changeRequest.fieldAddress': 'Dirección',
  'changeRequest.fieldEmail': 'Correo electrónico',
  'changeRequest.fieldPhone': 'Teléfono',
  'changeRequest.fieldLanguage': 'Idioma preferido',
  'changeRequest.whoseRecord': 'De quién es el registro',
  'changeRequest.whatToChange': 'Qué cambiar',
  'changeRequest.newValue': 'Nuevo valor',
  'changeRequest.submit': 'Enviar para revisión',
  'changeRequest.emailNote': 'Un cambio de correo electrónico entra en vigor para el inicio de sesión del portal una vez que el personal lo aplique.',
  'changeRequest.submittedHeading': 'Solicitud recibida',
  'changeRequest.submittedBody': 'Gracias — el personal de SVBC revisará tu solicitud y aplicará el cambio. Esto normalmente toma unos días hábiles.',
  'changeRequest.duplicateHeading': 'Ya enviada',
  'changeRequest.duplicateBody': 'Ya tenemos esta misma solicitud registrada — el personal la atenderá pronto. No es necesario enviarla de nuevo.',
  'changeRequest.invalidHeading': 'Algo necesita corregirse',
  'changeRequest.backToForm': 'Volver al formulario',
  'changeRequest.unavailableHeading': 'Solicitar un cambio',
  'changeRequest.unavailableBody': 'Las solicitudes de cambio de autoservicio aún no están disponibles. Por favor contacta a SVBC y actualizaremos tus datos por ti.',

  // Membership card + public verify page
  'card.heading': 'Tu tarjeta de membresía',
  'card.tier': 'Nivel: {{tier}}',
  'card.status': 'Estado: {{status}}',
  'card.expires': 'Vence: {{expiry}}',
  'card.scanHint': 'Muestra esta tarjeta, o deja que una tienda escanee el código QR o abra el enlace de arriba, para confirmar tu membresía.',
  'card.regenerate': 'Regenerar tarjeta',
  'card.regenerateHint': 'Regenerarla invalida de inmediato el código QR y el enlace anteriores — usa esta opción si crees que el enlace de tu tarjeta se ha filtrado.',
  'card.unavailable': 'Las tarjetas de membresía digitales aún no están disponibles. Por favor vuelve a consultar pronto.',
  'verify.heading': 'Verificación de membresía',
  'verify.disclaimer': 'Esta información se obtiene en tiempo real de nuestros registros.',
  'verify.notValid': 'Esta tarjeta no es válida. Es posible que haya sido regenerada o que ya no esté activa.',

  // Login email (src/email/resend.ts)
  'email.subject': 'Tu enlace de acceso al portal de donantes de SVBC',
  'email.bodyIntro': 'Haz clic abajo para iniciar sesión en el portal de donantes. Este enlace caduca pronto y solo se puede usar una vez.',
  'email.loginButton': 'Iniciar sesión',
} satisfies Record<TranslationKey, string>;
