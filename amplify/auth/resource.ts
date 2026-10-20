import { defineAuth } from '@aws-amplify/backend';

/**
 * Customers sign in with email + password (verified by a code sent to their email).
 * Members of the ADMINS group can see and update every enquiry on /admin.html.
 * Members of the ARTISTS group use /artist.html to price works (they never see customer details).
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // ADMINS: Studio desk (/admin.html). ARTISTS: Artist desk (/artist.html) for Siva.
  groups: ['ADMINS', 'ARTISTS'],
});
