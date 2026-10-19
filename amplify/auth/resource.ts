import { defineAuth } from '@aws-amplify/backend';

/**
 * Customers sign in with email + password (verified by a code sent to their email).
 * Members of the ADMINS group can see and update every enquiry on /admin.html.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ['ADMINS'],
});
