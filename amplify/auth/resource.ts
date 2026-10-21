import { defineAuth } from '@aws-amplify/backend';

/**
 * Customers sign in with email + password (verified by a code sent to their email).
 * Members of the ADMINS group can see and update every enquiry on /admin.html.
 * Members of the ARTISTS group use /artist.html to price works (they never see customer details).
 *
 * Emails (sign-up codes, password resets) are sent through Amazon SES from noreply@pranixtechno.com
 * (domain verified in SES, us-east-1, production access). Replies go to kalaiarthouse@pranixtechno.com.
 */
export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailStyle: 'CODE',
      verificationEmailSubject: 'Your Kalai Art House code',
      verificationEmailBody: (createCode) =>
        `Welcome to Kalai Art House.<br><br>Your verification code is <b>${createCode()}</b><br><br>` +
        `Enter it on art.pranixtechno.com to finish creating your account. If you didn't ask for this, you can ignore this email.`,
    },
  },
  senders: {
    email: {
      fromEmail: 'noreply@pranixtechno.com',
      fromName: 'Kalai Art House',
      replyTo: 'kalaiarthouse@pranixtechno.com',
    },
  },
  // ADMINS: Studio desk (/admin.html). ARTISTS: Artist desk (/artist.html) for Siva.
  groups: ['ADMINS', 'ARTISTS'],
});
