import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { parseEventTopicHeader } from "./poller.js";

const actor = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("parseEventTopicHeader", () => {
  it("parses legacy event topics as version 1", () => {
    const topics = [
      xdr.ScVal.scvSymbol("JobCreated"),
      nativeToScVal(new Address(actor)),
    ];

    expect(parseEventTopicHeader(topics)).toEqual({
      eventName: "JobCreated",
      version: 1,
      actor,
    });
  });

  it("parses versioned event topics and their actor", () => {
    const topics = [
      xdr.ScVal.scvSymbol("JobCreated"),
      xdr.ScVal.scvU32(2),
      nativeToScVal(new Address(actor)),
    ];

    expect(parseEventTopicHeader(topics)).toEqual({
      eventName: "JobCreated",
      version: 2,
      actor,
    });
  });

  it("preserves unknown event versions for forward compatibility", () => {
    const topics = [
      xdr.ScVal.scvSymbol("JobCreated"),
      xdr.ScVal.scvU32(3),
      nativeToScVal(new Address(actor)),
    ];

    expect(parseEventTopicHeader(topics)?.version).toBe(3);
  });
});
