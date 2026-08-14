// Markers that identify a HAC *logged-out* page. These are form field names from
// the LogOn view, not prose, because prose is not ours: page text can contain
// anything a school types in. The previous marker was the banner string
// "Welcome to", which matched both the Katy ISD login banner AND ordinary
// gradebook content (an assignment titled "Welcome to AP Lang Notes"), so a
// perfectly good login was reported as "Invalid username or password".
//
// Verified absent from every authenticated HAC page (WeekView, Assignments) and
// present on the LogOn view. `Account/LogOn` additionally catches a page that
// merely links back to the login form.
const LOGGED_OUT_MARKERS = [
    'LogOnDetails.UserName', // the username input's name attribute
    'LogOnDetails_UserName', // ...and its id, for skins that render only one
    'Account/LogOn',         // the login form's action / a link back to it
];

const ERROR_MESSAGES = {
    DISTRICT_NOT_FOUND: "District not Found",
    INVALID_USERNAME_PASSWORD: "Invalid username or password",
    MISSING_PARAMETERS: "Missing one or more required parameters",
    INVALID_MONTH: "Invalid month name",
    BELL_SCHEDULE_NOT_FOUND: "Bell Schedule not found"
};

const HAC_ENDPOINTS = {
    LOGIN: 'HomeAccess/Account/LogOn',
    REGISTRATION: 'HomeAccess/Content/Student/Registration.aspx',
    ASSIGNMENTS: 'HomeAccess/Content/Student/Assignments.aspx',
    CLASSES: 'HomeAccess/Content/Student/Classes.aspx',
    ATTENDANCE: 'HomeAccess/Content/Attendance/MonthlyView.aspx',
    INTERIM_PROGRESS: 'HomeAccess/Content/Student/InterimProgress.aspx',
    REPORT_CARDS: 'HomeAccess/Content/Student/ReportCards.aspx',
    TRANSCRIPT: 'HomeAccess/Content/Student/Transcript.aspx',
    HOME: 'HomeAccess'
};

const MONTH_INPUTS = {
    'january': 0, 'jan': 0, '01': 0, 1: 0,
    'february': 1, 'feb': 1, '02': 1, 2: 1,
    'march': 2, 'mar': 2, '03': 2, 3: 2,
    'april': 3, 'apr': 3, '04': 3, 4: 3,
    'may': 4, '05': 4, 5: 4,
    'june': 5, 'jun': 5, '06': 5, 6: 5,
    'july': 6, 'jul': 6, '07': 6, 7: 6,
    'august': 7, 'aug': 7, '08': 7, 8: 7,
    'september': 8, 'sept': 8, 'sep': 8, '09': 8, 9: 8,
    'october': 9, 'oct': 9, 10: 9,
    'november': 10, 'nov': 10, 11: 10,
    'december': 11, 'dec': 11, 12: 11,
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export {
    ERROR_MESSAGES,
    LOGGED_OUT_MARKERS,
    HAC_ENDPOINTS,
    MONTH_INPUTS,
    MONTH_NAMES
};

