// messages.js - every user-facing string, in one place.
// Pick the language with the LOCALE var ("he" default, or "en"). To add a
// language, copy a block and translate it. Keep the wording neutral: the
// denial message must not reveal whether a number is on the allowlist.

const he = {
  dir: "rtl",
  pageSub: "מזינים מספר טלפון ומקבלים קוד התחברות בוואטסאפ.",
  phoneLabel: "מספר טלפון",
  phonePlaceholder: "050-0000000",
  sendBtn: "שליחת קוד",
  codeLabel: "הקוד שקיבלת",
  verifyBtn: "כניסה",
  changeNumber: "שינוי מספר",
  busy: "רגע…",
  connecting: "מחברים אותך…",
  connectingSub: "רגע אחד, מסיימים את ההתחברות",
  codeSentSub: "שלחנו קוד בן 6 ספרות לוואטסאפ שלך.",
  codeValid: "הקוד תקף ל-5 דקות.",
  needPhone: "צריך מספר טלפון.",
  needCode: "צריך להזין את הקוד.",
  sendFailedGeneric: "לא הצלחנו לשלוח קוד.",
  wrongCodeGeneric: "הקוד לא נכון.",
  networkError: "תקלת רשת. אפשר לנסות שוב.",

  sessionExpired: "פג תוקף ההתחברות. רעננו את הדף ונסו שוב.",
  badPhone: "מספר הטלפון לא תקין.",
  tooManyIp: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד שעה.",
  denied: "המספר הזה לא מורשה להתחבר. אפשר לפנות לבעל העסק.",
  tooManyPhone: "נשלחו יותר מדי קודים למספר הזה. אפשר לנסות שוב בעוד שעה.",
  cooldown: (sec) => `כבר נשלח קוד. אפשר לבקש שוב בעוד ${sec} שניות.`,
  sendFailed: "לא הצלחנו לשלוח את הקוד בוואטסאפ. אפשר לנסות שוב בעוד רגע.",
  noCodeSent: "לא נשלח קוד. חזרו אחורה והזינו מספר.",
  codeExpired: "הקוד פג תוקף. אפשר לבקש קוד חדש.",
  tooManyAttempts: "יותר מדי ניסיונות שגויים. בקשו קוד חדש.",
  wrongCode: (left) => (left > 0 ? `הקוד לא נכון. נותרו ${left} ניסיונות.` : "הקוד לא נכון."),
  provisionFailed: "לא הצלחנו להשלים את הכניסה. אפשר לנסות שוב בעוד רגע.",

  badRequestTitle: "בקשה לא תקינה",
  badClient: "מזהה היישום אינו מוכר.",
  badResponseType: "נתמך response_type=code בלבד.",
  badRedirect: "כתובת ההחזרה אינה ברשימת המאושרות.",
  defaultAppName: "התחברות",

  otpText: (biz, code) =>
    `קוד ההתחברות שלך ל-${biz} הוא ${code}\n\n` +
    `הקוד תקף ל-5 דקות. אם לא ביקשת להתחבר, אפשר להתעלם מההודעה.`,
};

const en = {
  dir: "ltr",
  pageSub: "Enter your phone number and get a login code on WhatsApp.",
  phoneLabel: "Phone number",
  phonePlaceholder: "Phone number",
  sendBtn: "Send code",
  codeLabel: "The code you received",
  verifyBtn: "Log in",
  changeNumber: "Change number",
  busy: "One moment…",
  connecting: "Signing you in…",
  connectingSub: "One moment, finishing the login",
  codeSentSub: "We sent a 6-digit code to your WhatsApp.",
  codeValid: "The code is valid for 5 minutes.",
  needPhone: "A phone number is required.",
  needCode: "Please enter the code.",
  sendFailedGeneric: "We could not send a code.",
  wrongCodeGeneric: "That code is not correct.",
  networkError: "Network problem. Please try again.",

  sessionExpired: "This login has expired. Refresh the page and try again.",
  badPhone: "That phone number is not valid.",
  tooManyIp: "Too many attempts. Try again in an hour.",
  denied: "This number is not allowed to log in. Please contact the business owner.",
  tooManyPhone: "Too many codes were sent to this number. Try again in an hour.",
  cooldown: (sec) => `A code was already sent. You can request another in ${sec} seconds.`,
  sendFailed: "We could not send the code on WhatsApp. Try again in a moment.",
  noCodeSent: "No code was sent. Go back and enter your number.",
  codeExpired: "The code has expired. You can request a new one.",
  tooManyAttempts: "Too many wrong attempts. Request a new code.",
  wrongCode: (left) => (left > 0 ? `That code is not correct. ${left} attempts left.` : "That code is not correct."),
  provisionFailed: "We could not finish the login. Try again in a moment.",

  badRequestTitle: "Invalid request",
  badClient: "Unknown application.",
  badResponseType: "Only response_type=code is supported.",
  badRedirect: "The redirect address is not on the approved list.",
  defaultAppName: "Log in",

  otpText: (biz, code) =>
    `Your login code for ${biz} is ${code}\n\n` +
    `The code is valid for 5 minutes. If you did not ask to log in, you can ignore this message.`,
};

const LOCALES = { he, en };

export function messages(env) {
  return LOCALES[String((env && env.LOCALE) || "he").toLowerCase()] || he;
}
