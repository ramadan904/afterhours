/**
 * The store on Amazon DynamoDB, for deployments on AWS.
 *
 * One table, partition key `k` (string), value `v` (JSON string) and an
 * optional `ttl` (epoch seconds) with DynamoDB's TTL feature enabled on it
 * (see infra/aws.yaml). DynamoDB deletes expired items lazily, up to a day or
 * two late, so every read also treats an item past its `ttl` as missing.
 *
 * One-time values (OAuth codes, refresh tokens) rely on `take`, which is a
 * single DeleteItem returning the old item: two concurrent redemptions of the
 * same code can't both get it.
 */

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { Store } from "./store.js";

/** The subset of DynamoDBClient used here, so tests can pass a fake. */
export interface DynamoLike {
  send(command: GetItemCommand | PutItemCommand | DeleteItemCommand): Promise<{ Item?: Record<string, AttributeValue>; Attributes?: Record<string, AttributeValue> }>;
}

export class DynamoStore implements Store {
  constructor(
    private readonly table: string,
    private readonly client: DynamoLike = new DynamoDBClient({}),
    private readonly now: () => number = Date.now,
  ) {}

  private item(key: string, value: unknown, ttlSeconds?: number): Record<string, AttributeValue> {
    const item: Record<string, AttributeValue> = { k: { S: key }, v: { S: JSON.stringify(value) } };
    if (ttlSeconds) item.ttl = { N: String(Math.floor(this.now() / 1000) + ttlSeconds) };
    return item;
  }

  private live<T>(item: Record<string, AttributeValue> | undefined): T | null {
    if (!item?.v?.S) return null;
    if (item.ttl?.N && Number(item.ttl.N) * 1000 <= this.now()) return null;
    return JSON.parse(item.v.S) as T;
  }

  async get<T>(key: string): Promise<T | null> {
    const res = await this.client.send(new GetItemCommand({ TableName: this.table, Key: { k: { S: key } }, ConsistentRead: true }));
    return this.live<T>(res.Item);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.client.send(new PutItemCommand({ TableName: this.table, Item: this.item(key, value, ttlSeconds) }));
  }

  async setNew(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: this.item(key, value, ttlSeconds),
          // Absent, or present but already expired (TTL deletion lags).
          ConditionExpression: "attribute_not_exists(k) OR (attribute_exists(#ttl) AND #ttl <= :now)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":now": { N: String(Math.floor(this.now() / 1000)) } },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || (err as Error).name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async del(key: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: { k: { S: key } } }));
  }

  async take<T>(key: string): Promise<T | null> {
    const res = await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: { k: { S: key } }, ReturnValues: "ALL_OLD" }));
    return this.live<T>(res.Attributes);
  }
}
