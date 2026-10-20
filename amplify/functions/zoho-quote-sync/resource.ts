import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * Runs whenever a new enquiry is saved and creates a quote (estimate) in Zoho Books,
 * always against one fixed customer. The website customer's details go in the quote notes.
 * Set the three ZOHO_* secrets in Amplify console → Hosting → Secrets (see ZOHO-SETUP.md).
 */
export const zohoQuoteSync = defineFunction({
  name: 'zoho-quote-sync',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    ZOHO_ORG_ID: '941662167',
    ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',
    ZOHO_API_URL: 'https://www.zohoapis.com/books/v3',
    // The one customer every quote is raised against. Created automatically if it doesn't exist.
    ZOHO_CUSTOMER_NAME: 'Kalai Art House - Website',
    ZOHO_CLIENT_ID: secret('ZOHO_CLIENT_ID'),
    ZOHO_CLIENT_SECRET: secret('ZOHO_CLIENT_SECRET'),
    ZOHO_REFRESH_TOKEN: secret('ZOHO_REFRESH_TOKEN'),
  },
});
