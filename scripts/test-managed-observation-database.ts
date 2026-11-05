import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import type { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';

/** Real PostgreSQL rows and private local storage; the pause only places a real competing edit between observation reads. */
export async function verifyManagedObservationDatabase(input: { admin: PrismaClient; service: ManagedService; media: ManagedMediaService;
  organizationId: string; otherOrganizationId: string; credential: string; managedPostId: string; revision: number;
  integrationId: string; generation: number; mediaId: string; sha256: string; byteLength: number }) {
  const { admin, service, media, organizationId: org, managedPostId, revision } = input;
  const retained = async () => JSON.stringify(await Promise.all([
    admin.managedOrganization.findMany({ orderBy: { organizationId: 'asc' } }),
    admin.managedChannelBinding.findMany({ orderBy: { integrationId: 'asc' } }),
    admin.managedPost.findMany({ orderBy: { id: 'asc' } }),
    admin.managedPostRevision.findMany({ orderBy: { id: 'asc' } }),
    admin.managedOperation.findMany({ orderBy: { id: 'asc' } }),
    admin.managedMediaEvidence.findMany({ orderBy: { id: 'asc' } }),
    admin.managedChangeEvent.findMany({ orderBy: { id: 'asc' } }),
    admin.media.findMany({ orderBy: { id: 'asc' } }),
    admin.post.findMany({ orderBy: { id: 'asc' } }),
    admin.integration.findMany({ orderBy: { id: 'asc' } }),
  ]));
  const before = await retained();
  const result = await service.observeCurrentMedia(org, managedPostId, revision);
  assert.equal(result.status, 'VERIFIED'); assert('media' in result);
  assert.equal(result.media.length, 1);
  assert.deepEqual(result.media.map(item => [item.mediaId, item.sha256, item.byteLength, item.status]),
    [[input.mediaId, input.sha256, input.byteLength, 'VERIFIED']]);
  assert.equal(result.binding.generation, input.generation);
  assert.equal(result.binding.status, 'QUALIFIED');
  assert(Date.parse(result.startedAt) <= Date.parse(result.media[0].observedAt));
  assert(Date.parse(result.media[0].observedAt) <= Date.parse(result.finishedAt));
  assert.equal(await retained(), before, 'Observation must not modify any retained row or evidence');
  const original = media.observeEvidence;
  let reads = 0;
  media.observeEvidence = async (...args: Parameters<typeof original>) => { reads++; return original.apply(media, args); };
  try {
    await assert.rejects(service.observeCurrentMedia(org, managedPostId, revision - 1), (error: any) => error.getResponse?.().code === 'REVISION_CONFLICT');
    await assert.rejects(service.observeCurrentMedia(input.otherOrganizationId, managedPostId, revision), (error: any) => error.getStatus?.() === 404);
    assert.equal(reads, 0, 'Foreign or stale revision must refuse before storage');
    assert.equal(await retained(), before);
  } finally { media.observeEvidence = original; }
  console.log('PASS real current-media observation: exact private bytes and revision, no database writes or repinning, stale and foreign requests refuse before storage');

  let release!: () => void, entered!: () => void;
  const enteredRead = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const deadline = setTimeout(release, 10_000);
  media.observeEvidence = async (...args: Parameters<typeof original>) => {
    const observed = await original.apply(media, args); entered(); await hold; return observed;
  };
  try {
    const inFlight = service.observeCurrentMedia(org, managedPostId, revision);
    await enteredRead;
    await service.editDraft(org, input.credential, managedPostId, {
      operationKey: 'ww:db:observe:competing-edit', expectedBindingGeneration: input.generation, expectedRevision: revision,
      intendedPublishDate: '2026-11-08T09:00:00.000Z', settings: {},
      members: [{ content: 'New approved synthetic revision during observation', delay: 0, media: [{ mediaId: input.mediaId, sha256: input.sha256 }] },
        { content: 'Retained child', delay: 1, media: [] }],
    });
    release();
    const interrupted = await inFlight;
    assert.equal(interrupted.status, 'INDETERMINATE');
    assert(interrupted.reasons.includes('POST_CHANGED_DURING_OBSERVATION' as never));
    assert(!('media' in interrupted), 'A changed revision must carry no partial positive media claims');
    assert.equal((await service.getPost(org, managedPostId)).revision, revision + 1);
  } finally { release(); clearTimeout(deadline); media.observeEvidence = original; }
  console.log('PASS real current-media race: a committed same-post edit during the private read returns indeterminate without per-item success claims');
}
