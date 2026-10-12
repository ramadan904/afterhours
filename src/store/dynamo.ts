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
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { Store } from "./store.js";

/** The subset of DynamoDBClient used here, so tests can pass a fake. */
export interface DynamoLike {
  send(command: GetItemCommand | PutItemCommand | DeleteItemCommand | UpdateItemCommand): Promise<{ Item?: Record<string, AttributeValue>; Attributes?: Record<string, AttributeValue> }>;
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

  /**
   * ADD is atomic, and the TTL is set only on the first increment. A counter
   * past its TTL may not be deleted yet (DynamoDB lags), so the update is
   * conditional on it being live; an expired one is replaced by a fresh count.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const nowS = Math.floor(this.now() / 1000);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await this.client.send(
          new UpdateItemCommand({
            TableName: this.table,
            Key: { k: { S: key } },
            UpdateExpression: "ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)",
            ConditionExpression: "attribute_not_exists(#ttl) OR #ttl > :now",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":one": { N: "1" }, ":ttl": { N: String(nowS + ttlSeconds) }, ":now": { N: String(nowS) } },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        return Number(res.Attributes?.n?.N ?? 1);
      } catch (err) {
        if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
        // Expired: start over at 1, unless another instance just did.
        if (await this.setCounter(key, nowS + ttlSeconds, nowS)) return 1;
      }
    }
    return 1;
  }

  private async setCounter(key: string, ttl: number, nowS: number): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: { k: { S: key }, n: { N: "1" }, ttl: { N: String(ttl) } },
          ConditionExpression: "attribute_not_exists(k) OR #ttl <= :now",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":now": { N: String(nowS) } },
        }),
      );
      return true;
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }
}
