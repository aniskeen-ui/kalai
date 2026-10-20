import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
import { Policy, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { StartingPosition, EventSourceMapping } from 'aws-cdk-lib/aws-lambda';
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
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
    resources: [tableArn('Enquiry'), tableArn('Costing')],
  }),
);

// Commission photos for the Artist desk (signed links). The bucket is in the storage stack, which doesn't depend on data.
backend.zohoQuoteSync.addEnvironment('UPLOADS_BUCKET', backend.storage.resources.bucket.bucketName);
backend.storage.resources.bucket.grantRead(backend.zohoQuoteSync.resources.lambda, 'uploads/*');

// VAT switch (/kalai/zoho/vat_tax_id).
backend.zohoQuoteSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['ssm:GetParameter'],
    resources: [`arn:aws:ssm:${fnStack.region}:${fnStack.account}:parameter/kalai/zoho/*`],
  }),
);
