import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
import { Policy, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { StartingPosition, EventSourceMapping, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { zohoQuoteSync } from './functions/zoho-quote-sync/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  zohoQuoteSync,
});

// Send every new enquiry to Zoho Books as a quote.
const enquiryTable = backend.data.resources.tables['Enquiry'];

const streamPolicy = new Policy(Stack.of(enquiryTable), 'ZohoQuoteSyncStreamPolicy', {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
      resources: [enquiryTable.tableStreamArn!],
    }),
  ],
});
backend.zohoQuoteSync.resources.lambda.role?.attachInlinePolicy(streamPolicy);

const mapping = new EventSourceMapping(Stack.of(enquiryTable), 'ZohoQuoteSyncEnquiryStream', {
  target: backend.zohoQuoteSync.resources.lambda,
  eventSourceArn: enquiryTable.tableStreamArn,
  startingPosition: StartingPosition.LATEST,
  batchSize: 10,
  retryAttempts: 3,
  reportBatchItemFailures: true,
});
mapping.node.addDependency(streamPolicy);

// Let the sync read/write the Enquiry and Costing tables. Referenced by NAME (Model-<apiId>-NONE), not by
// table object: the Enquiry table already points at this function (stream), so a direct reference back
// would make a circular dependency between the nested stacks.
const fnStack = Stack.of(backend.zohoQuoteSync.resources.lambda);
const apiId = backend.data.resources.graphqlApi.apiId;
const tableName = (model: string) => `${model}-${apiId}-NONE`;
const tableArn = (model: string) => `arn:aws:dynamodb:${fnStack.region}:${fnStack.account}:table/${tableName(model)}`;
backend.zohoQuoteSync.addEnvironment('ENQUIRY_TABLE', tableName('Enquiry'));
backend.zohoQuoteSync.addEnvironment('COSTING_TABLE', tableName('Costing'));
backend.zohoQuoteSync.addEnvironment('PRODUCT_TABLE', tableName('Product'));
backend.zohoQuoteSync.addEnvironment('SELLER_TABLE', tableName('SellerProfile'));
backend.zohoQuoteSync.addEnvironment('LISTING_TABLE', tableName('Listing'));
backend.zohoQuoteSync.addEnvironment('MARKET_TABLE', tableName('MarketItem'));
backend.zohoQuoteSync.addEnvironment('ARTIST_TABLE', tableName('ArtistProfile'));
backend.zohoQuoteSync.addEnvironment('ANNOUNCE_TABLE', tableName('Announcement'));
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
    resources: [tableArn('Enquiry'), tableArn('Costing'), tableArn('Product'), tableArn('SellerProfile'), tableArn('Listing'), tableArn('MarketItem'), tableArn('ArtistProfile'), tableArn('Announcement')],
  }),
);

// Commission photos for the Artist desk (signed links). The bucket is in the storage stack, which doesn't depend on data.
backend.zohoQuoteSync.addEnvironment('UPLOADS_BUCKET', backend.storage.resources.bucket.bucketName);
backend.storage.resources.bucket.grantRead(backend.zohoQuoteSync.resources.lambda, 'uploads/*');
// Catalogue import from links: the function saves the downloaded pictures here.
backend.storage.resources.bucket.grantPut(backend.zohoQuoteSync.resources.lambda, 'catalogue/*');

// VAT switch (/kalai/zoho/vat_tax_id).
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['ssm:GetParameter'],
    resources: [
      `arn:aws:ssm:${fnStack.region}:${fnStack.account}:parameter/kalai/zoho/*`,
      `arn:aws:ssm:${fnStack.region}:${fnStack.account}:parameter/kalai/email/*`,
      `arn:aws:ssm:${fnStack.region}:${fnStack.account}:parameter/kalai/ziina/*`,
      `arn:aws:ssm:${fnStack.region}:${fnStack.account}:parameter/kalai/kural/*`,
    ],
  }),
);

// Daily message translation (Tamil → English, Arabic).
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({ effect: Effect.ALLOW, actions: ['translate:TranslateText'], resources: ['*'] }),
);

// Order emails to customers and the studio (Amazon SES, verified domain pranixtechno.com).
// Switch off with the SSM parameter /kalai/email/enabled = off.
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['ses:SendEmail', 'ses:SendRawEmail'],
    resources: [`arn:aws:ses:${fnStack.region}:${fnStack.account}:identity/*`],
  }),
);

// Login emails (sign-up codes, password resets): send through the verified DOMAIN identity in SES.
// Amplify's `senders.email` points Cognito at the single address noreply@…, which SES lists as "pending"
// (no mailbox to confirm it); Cognito refuses a pending identity. The domain identity is fully verified.
const authStack = Stack.of(backend.auth.resources.userPool);
backend.auth.resources.cfnResources.cfnUserPool.addPropertyOverride(
  'EmailConfiguration.SourceArn',
  `arn:aws:ses:${authStack.region}:${authStack.account}:identity/pranixtechno.com`,
);


// Ziina payment notifications: a public HTTPS address for the same function (checked by IP + signature inside).
// The address is published in amplify_outputs.json so the studio page can register it with Ziina.
const ziinaHook = backend.zohoQuoteSync.resources.lambda.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
backend.addOutput({ custom: { ziinaWebhookUrl: ziinaHook.url } });

// Thirukkural of the day: every morning at 06:05 Dubai (02:05 UTC) the function publishes the day's kural.
new Rule(fnStack, 'DailyKuralRule', {
  schedule: Schedule.cron({ minute: '5', hour: '2' }),
  targets: [new LambdaFunction(backend.zohoQuoteSync.resources.lambda, { event: RuleTargetInput.fromObject({ task: 'dailyKural' }) })],
});
