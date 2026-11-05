import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  CreativeCallStatus,
  CreativePollStatus,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';

// Prisma access of the owned creative runtime (docs/managed-extension/
// creative-runtime.md). Every query names the organization of the
// credential. A call row is created once per (organization, callKey) and
// only leaves DISPATCHING through a conditional update, so no second request
// or process can settle, or send, it again. Rows are never deleted. No url,
// signed or not, and no provider key is ever written here.

export interface CreativeJobRow {
  id: string;
  organizationId: string;
  jobId: string;
  tenantId: string;
  workspaceId: string;
  kind: string;
  inputSha256: string;
  // canonical JSON of the closed input
  input: string;
  credentialId: string;
}

export interface CreativeCallRow {
  id: string;
  organizationId: string;
  // null for a call refused before its job was bound
  jobRowId: string | null;
  callKey: string;
  requestHash: string;
  stage: string;
  item: number;
  attempt: number;
  status: CreativeCallStatus;
  code: string | null;
  handleKey: string | null;
  // JSON of the owned handle; never returned as is
  handle: string | null;
  // JSON of the exact answer, replayed as is
  answer: string | null;
  // JSON, server-private: the script, the picked clips, voice lengths
  intermediate: string | null;
  pollStatus: CreativePollStatus | null;
  pollAnswer: string | null;
  pollIntermediate: string | null;
}

export interface CreativeObjectRow {
  role: string;
  slot: number;
  storageKey: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  assetId: string | null;
  assetVersion: number | null;
}

export type CreativeCallCreate = Pick<
  CreativeCallRow,
  | 'jobRowId'
  | 'callKey'
  | 'requestHash'
  | 'stage'
  | 'item'
  | 'attempt'
  | 'status'
  | 'code'
  | 'handleKey'
  | 'handle'
  | 'answer'
> & { credentialId: string };

export type CreativeCallSettle = Pick<
  CreativeCallRow,
  'status' | 'code' | 'handleKey' | 'handle' | 'answer' | 'intermediate'
>;

export type CreativePollSettle = Pick<
  CreativeCallRow,
  'pollAnswer' | 'pollIntermediate'
> & { pollStatus: CreativePollStatus };

const JOB_SELECT = {
  id: true,
  organizationId: true,
  jobId: true,
  tenantId: true,
  workspaceId: true,
  kind: true,
  inputSha256: true,
  input: true,
  credentialId: true,
} as const;

const CALL_SELECT = {
  id: true,
  organizationId: true,
  jobRowId: true,
  callKey: true,
  requestHash: true,
  stage: true,
  item: true,
  attempt: true,
  status: true,
  code: true,
  handleKey: true,
  handle: true,
  answer: true,
  intermediate: true,
  pollStatus: true,
  pollAnswer: true,
  pollIntermediate: true,
} as const;

const OBJECT_SELECT = {
  role: true,
  slot: true,
  storageKey: true,
  sha256: true,
  byteLength: true,
  contentType: true,
  assetId: true,
  assetVersion: true,
} as const;

// a unique key someone else already holds: the caller reads that row instead
const taken = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class ManagedCreativeRepository {
  constructor(private _transaction: PrismaTransaction) {}

  private run<T>(func: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this._transaction.model.$transaction(func);
  }

  getJob(organizationId: string, jobId: string) {
    return this.run(
      (tx) =>
        tx.managedCreativeJob.findFirst({
          where: { organizationId, jobId },
          select: JOB_SELECT,
        }) as Promise<CreativeJobRow | null>
    );
  }

  getJobByRow(organizationId: string, id: string) {
    return this.run(
      (tx) =>
        tx.managedCreativeJob.findFirst({
          where: { organizationId, id },
          select: JOB_SELECT,
        }) as Promise<CreativeJobRow | null>
    );
  }

  // null when another request bound the job first
  async createJob(
    organizationId: string,
    data: Omit<CreativeJobRow, 'id' | 'organizationId'>
  ): Promise<CreativeJobRow | null> {
    try {
      return (await this.run((tx) =>
        tx.managedCreativeJob.create({
          data: { ...data, organizationId },
          select: JOB_SELECT,
        })
      )) as CreativeJobRow;
    } catch (err) {
      if (taken(err)) {
        return null;
      }
      throw err;
    }
  }

  getCall(organizationId: string, callKey: string) {
    return this.run(
      (tx) =>
        tx.managedCreativeCall.findFirst({
          where: { organizationId, callKey },
          select: CALL_SELECT,
        }) as Promise<CreativeCallRow | null>
    );
  }

  getCallByHandle(organizationId: string, handleKey: string) {
    return this.run(
      (tx) =>
        tx.managedCreativeCall.findFirst({
          where: { organizationId, handleKey },
          select: CALL_SELECT,
        }) as Promise<CreativeCallRow | null>
    );
  }

  // The gate of every send: null when the call key (or the handle) is
  // already recorded, by an earlier request or a concurrent one
  async createCall(
    organizationId: string,
    data: CreativeCallCreate
  ): Promise<CreativeCallRow | null> {
    try {
      return (await this.run((tx) =>
        tx.managedCreativeCall.create({
          data: { ...data, organizationId },
          select: CALL_SELECT,
        })
      )) as CreativeCallRow;
    } catch (err) {
      if (taken(err)) {
        return null;
      }
      throw err;
    }
  }

  // Only from DISPATCHING, once, together with the objects the call
  // retained. false when the row was not DISPATCHING any more
  settleCall(
    organizationId: string,
    jobRowId: string,
    id: string,
    data: CreativeCallSettle,
    objects: CreativeObjectRow[]
  ) {
    return this.run(async (tx) => {
      const { count } = await tx.managedCreativeCall.updateMany({
        where: { id, organizationId, status: 'DISPATCHING' },
        data,
      });
      if (count !== 1) {
        return false;
      }
      if (objects.length) {
        await tx.managedCreativeObject.createMany({
          data: objects.map((object) => ({ ...object, organizationId, jobRowId })),
          skipDuplicates: true,
        });
      }
      return true;
    });
  }

  // The final read of a handle, once. false when another poll recorded it
  settlePoll(
    organizationId: string,
    jobRowId: string,
    id: string,
    data: CreativePollSettle,
    objects: CreativeObjectRow[]
  ) {
    return this.run(async (tx) => {
      const { count } = await tx.managedCreativeCall.updateMany({
        where: { id, organizationId, pollStatus: null },
        data,
      });
      if (count !== 1) {
        return false;
      }
      if (objects.length) {
        await tx.managedCreativeObject.createMany({
          data: objects.map((object) => ({ ...object, organizationId, jobRowId })),
          skipDuplicates: true,
        });
      }
      return true;
    });
  }

  listCalls(organizationId: string, jobRowId: string) {
    return this.run(
      (tx) =>
        tx.managedCreativeCall.findMany({
          where: { organizationId, jobRowId },
          select: CALL_SELECT,
          orderBy: { createdAt: 'asc' },
        }) as Promise<CreativeCallRow[]>
    );
  }

  listObjects(organizationId: string, jobRowId: string) {
    return this.run(
      (tx) =>
        tx.managedCreativeObject.findMany({
          where: { organizationId, jobRowId },
          select: OBJECT_SELECT,
        }) as Promise<CreativeObjectRow[]>
    );
  }

  // Pins an object first read now (a clip, a source); the row already there
  // wins and is returned, so the caller compares digests
  async pinObject(
    organizationId: string,
    jobRowId: string,
    object: CreativeObjectRow
  ): Promise<CreativeObjectRow> {
    try {
      return (await this.run((tx) =>
        tx.managedCreativeObject.create({
          data: { ...object, organizationId, jobRowId },
          select: OBJECT_SELECT,
        })
      )) as CreativeObjectRow;
    } catch (err) {
      if (!taken(err)) {
        throw err;
      }
    }

    const existing = await this.run((tx) =>
      tx.managedCreativeObject.findFirst({
        where: { organizationId, jobRowId, role: object.role, slot: object.slot },
        select: OBJECT_SELECT,
      })
    );
    if (!existing) {
      throw new Error('The pinned creative object could not be read');
    }
    return existing as CreativeObjectRow;
  }
}
