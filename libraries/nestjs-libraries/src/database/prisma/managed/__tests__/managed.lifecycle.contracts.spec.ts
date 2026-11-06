import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  lifecycleAdmissionRowState, lifecycleAffectedHashInput, lifecycleCancelScope, lifecyclePayloadInput,
  lifecycleWhileScheduled, managedLifecycleIssues, parseManagedLifecycleRequest, parseManagedLifecycleResponse,
  parseManagedScheduleView, releaseHashInput, ManagedLifecycleKind, ManagedLifecycleResponseName,
} from '../managed.lifecycle.contracts';
import {
  ManagedLifecycleScheduleDto, ManagedLifecyclePublishNowDto, ManagedLifecycleCancelDto,
  ManagedLifecycleDeleteDto, ManagedLifecycleResolveDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.lifecycle.dto';

// Synthetic shared wire vectors; hashes are declared format fixtures, not
// calculated digests and never proof of trusted content.
const fixture = require('../lifecycle.contract.v1.json');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const DTO = {
  SCHEDULE: ManagedLifecycleScheduleDto, PUBLISH_NOW: ManagedLifecyclePublishNowDto,
  CANCEL: ManagedLifecycleCancelDto, DELETE: ManagedLifecycleDeleteDto, RESOLVE: ManagedLifecycleResolveDto,
};
const VALIDATE = { whitelist: true, forbidNonWhitelisted: true };
// every own key at every level, so an undefined extra on a DTO instance shows
const paths = (value: any, at = ''): string[] =>
  value && typeof value === 'object'
    ? Object.keys(value).flatMap((key) => [`${at}${key}`, ...paths(value[key], `${at}${key}.`)])
    : [];
const response = (name: string) => clone(fixture.responses[name].body);
const parses = (name: ManagedLifecycleResponseName, body: any) => parseManagedLifecycleResponse(name, body) !== null;
const ended = { endedAt: '2026-11-04T12:00:00.000Z' };
const noEndRequest = { endRequestedOperationKey: null, endRequestedAt: null };
// S1 occurrence 1, materialized once occurrence 0 published
const pendingOccurrence1 = () => ({
  ...clone(fixture.responses.acceptedResult.body.dispatches[0]),
  dispatchId: '00000000-0000-4000-8003-000000000011', occurrence: 1, dueAt: '2026-11-05T09:00:00.000Z',
  admissibleUntil: '2026-11-05T09:15:00.000Z', createdAt: '2026-11-04T09:06:10.000Z', updatedAt: '2026-11-04T09:06:10.000Z',
});
// an OCCURRENCE cancel of pending occurrence 1 of the ACTIVE S1, which goes on
const occurrenceCancel = () => {
  const body = response('cancelSeriesAfterTruncationResult');
  body.operationKey = 'fixture:cancel-occurrence:0002';
  body.lifecycle = 'SCHEDULED';
  Object.assign(body.schedule, { status: 'ACTIVE', scheduleVersion: 2, lastOccurrence: 6, ...noEndRequest, endedAt: null, endedOperationKey: null });
  body.dispatches[0].cancelledByOperationKey = body.operationKey;
  Object.assign(body.cancellation, { scope: 'OCCURRENCE', series: 'CONTINUES', cancelledOccurrences: [1] });
  return body;
};

describe('closed lifecycle wire contract', () => {
  for (const [name, test] of Object.entries(fixture.requests) as [string, any][]) {
    it(`accepts shared request ${name} through DTO and strict parser`, () => {
      const kind = test.kind as ManagedLifecycleKind;
      const dto = plainToInstance(DTO[kind] as any, test.body);
      expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      expect(managedLifecycleIssues(kind, test.body)).toEqual([]);
      expect(parseManagedLifecycleRequest(kind, test.body)).toEqual(test.body);
    });
    it(`refuses unknown keys and missing fields in ${name}`, () => {
      const kind = test.kind as ManagedLifecycleKind;
      expect(parseManagedLifecycleRequest(kind, { ...test.body, organizationId: 'foreign' })).toBeNull();
      for (const key of Object.keys(test.body)) {
        const body = clone(test.body); delete body[key];
        expect(parseManagedLifecycleRequest(kind, body)).toBeNull();
      }
    });
  }
  for (const [name, test] of Object.entries(fixture.responses) as [string, any][]) {
    it(`accepts shared response ${name}`, () => {
      expect(managedLifecycleIssues(test.parser, test.body)).toEqual([]);
      expect(parseManagedLifecycleResponse(test.parser as ManagedLifecycleResponseName, test.body)).toEqual(test.body);
    });
    it(`refuses unknown fields in ${name}`, () => {
      expect(parseManagedLifecycleResponse(test.parser, { ...test.body, token: 'unexpected' })).toBeNull();
    });
  }

  it('accepts delete and operation lookup for a never-scheduled draft at generation zero', () => {
    const result = fixture.responses.deleteDraftResult.body;
    expect(parseManagedLifecycleResponse('RESULT', result)).not.toBeNull();
    const lookup = { version: result.version, operationKey: result.operationKey, status: 'COMMITTED',
      asOfSequence: result.sequence, kind: result.kind, payloadHash: result.payloadHash, managedPostId: result.managedPostId,
      sequence: result.sequence, committedAt: result.committedAt, currentScheduleGeneration: 0,
      currentLifecycle: 'DELETED', ack: 'CURRENT', result };
    expect(parseManagedLifecycleResponse('OPERATION', lookup)).not.toBeNull();
    expect(parseManagedLifecycleResponse('OPERATION', { ...lookup, kind: 'SCHEDULE' })).toBeNull();
    expect(parseManagedLifecycleResponse('OPERATION', { ...lookup, ack: 'SUPERSEDED' })).toBeNull();
    expect(parseManagedLifecycleResponse('RESULT', { ...fixture.responses.acceptedResult.body, scheduleGeneration: 0 })).toBeNull();
  });

  it('truncates later future occurrences while leaving an earlier pending occurrence untouched', () => {
    const schedule = fixture.responses.acceptedResult.body.schedule;
    const pending = fixture.responses.acceptedResult.body.dispatches[0];
    expect(schedule.lastOccurrence).toBeGreaterThanOrEqual(2);
    const scope = lifecycleCancelScope(schedule, [pending], 'REMAINING', 2);
    expect(typeof scope).toBe('object');
    if (typeof scope === 'string') throw new Error(scope);
    expect(scope.inFlight).toBeNull();
    expect(scope.affected[0].occurrence).toBe(2);
    expect(scope.affected.every(item => item.state === 'NOT_MATERIALIZED')).toBe(true);
    const body = { ...fixture.requests.cancelRemainingFutureOnly.body, fromOccurrence: 2, ...scope };
    expect(parseManagedLifecycleRequest('CANCEL', body)).not.toBeNull();
    expect(lifecycleCancelScope(schedule, [pending], 'REMAINING', schedule.lastOccurrence + 1)).toBe('CANCEL_SCOPE_MISMATCH');
    expect(lifecycleCancelScope(schedule, [pending], 'OCCURRENCE', 2)).toBe('CANCEL_SCOPE_MISMATCH');
  });

  it('binds the unaffected admitted occurrence even when truncation starts more than one occurrence later', () => {
    const schedule = fixture.responses.acceptedResult.body.schedule;
    const admitted = fixture.responses.dispatchAdmittedInCall.body;
    const scope = lifecycleCancelScope(schedule, [admitted], 'REMAINING', 2);
    expect(typeof scope).toBe('object');
    if (typeof scope === 'string') throw new Error(scope);
    expect(scope.inFlight?.dispatchId).toBe(admitted.dispatchId);
    const body = { ...fixture.requests.cancelRemainingFutureOnly.body, fromOccurrence: 2, ...scope };
    expect(parseManagedLifecycleRequest('CANCEL', body)).not.toBeNull();
    expect(lifecycleCancelScope(schedule, [admitted], 'SERIES', null)).toBe('DISPATCH_IN_PROGRESS');
    expect(lifecycleCancelScope(schedule, [admitted], 'REMAINING', admitted.occurrence)).toBe('DISPATCH_IN_PROGRESS');
  });

  it('does not weaken current end-request bounds when a truncated series is cancelled again', () => {
    const schedule = { ...fixture.responses.acceptedResult.body.schedule, status: 'ENDING', lastOccurrence: 1 };
    const pending = fixture.responses.acceptedResult.body.dispatches[0];
    const scope = lifecycleCancelScope(schedule, [pending], 'SERIES', null);
    expect(typeof scope).toBe('object');
    if (typeof scope === 'string') throw new Error(scope);
    expect(scope.affected.map(item => item.occurrence)).toEqual([0, 1]);
  });

  it('refuses response confusion, gaps and inconsistent scope', () => {
    const operation = clone(fixture.responses.lookupCommitted.body);
    operation.result.managedPostId = fixture.responses.deleteDraftResult.body.managedPostId;
    expect(parseManagedLifecycleResponse('OPERATION', operation)).toBeNull();
    const events = clone(fixture.responses.eventsPage.body);
    events.events[0].sequence += 1;
    expect(parseManagedLifecycleResponse('EVENTS', events)).toBeNull();
    const result = clone(fixture.responses.acceptedResult.body);
    result.dispatches[0].managedPostId = fixture.responses.deleteDraftResult.body.managedPostId;
    expect(parseManagedLifecycleResponse('RESULT', result)).toBeNull();
  });

  it('parses the actual plainToInstance DTO, conditional keys included, exactly as the raw body', () => {
    const bodies: [ManagedLifecycleKind, any][] = [
      ...(Object.values(fixture.requests) as any[]).map((test): [ManagedLifecycleKind, any] => [test.kind, test.body]),
      ['CANCEL', { ...fixture.requests.cancelRemainingFutureOnly.body, inFlight: null }],
    ];
    for (const [kind, body] of bodies) {
      const dto = plainToInstance(DTO[kind] as any, clone(body));
      expect(validateSync(dto as object, VALIDATE)).toEqual([]);
      // no declared-but-absent field becomes an own undefined key
      expect(paths(dto).sort()).toEqual(paths(body).sort());
      expect(parseManagedLifecycleRequest(kind, dto)).toEqual(body);
    }
    // a key only another scope or state takes passes the DTO, never the parser
    const series = plainToInstance(ManagedLifecycleCancelDto, { ...clone(fixture.requests.cancelSeries.body), occurrence: 1 });
    expect(validateSync(series, VALIDATE)).toEqual([]);
    expect(parseManagedLifecycleRequest('CANCEL', series)).toBeNull();
    const extra = clone(fixture.requests.cancelSeries.body);
    extra.affected[1].dispatchId = '00000000-0000-4000-8003-000000000012';
    const transformed = plainToInstance(ManagedLifecycleCancelDto, extra);
    expect(validateSync(transformed, VALIDATE)).toEqual([]);
    expect(parseManagedLifecycleRequest('CANCEL', transformed)).toBeNull();
    const published = plainToInstance(ManagedLifecycleDeleteDto, { ...clone(fixture.requests.deletePublished.body),
      cancels: clone(fixture.requests.deleteScheduled.body.cancels) });
    expect(validateSync(published, VALIDATE)).toEqual([]);
    expect(parseManagedLifecycleRequest('DELETE', published)).toBeNull();
  });

  it('keeps the first end request through later cancels, a halt and a delete', () => {
    const first = 'fixture:cancel-remaining-pending:0001';
    const again = response('cancelRemainingAgainResult').schedule;
    expect(again.endRequestedOperationKey).toBe(first);
    expect(again.lastOccurrence).toBeLessThan(response('cancelRemainingPendingResult').schedule.lastOccurrence);
    const cancelled = response('cancelSeriesAfterTruncationResult').schedule;
    expect(parseManagedScheduleView(cancelled)).not.toBeNull();
    expect(cancelled.endedOperationKey).not.toBe(cancelled.endRequestedOperationKey);
    expect(parseManagedScheduleView(response('deleteAfterTruncationResult').schedule)).not.toBeNull();
    const halted = { ...again, status: 'HALTED', endedAt: '2026-11-05T09:20:00.000Z' };
    expect(parseManagedScheduleView(halted)).not.toBeNull();
    expect(parseManagedScheduleView({ ...halted, endedOperationKey: 'fixture:resolve-halt:0001' })).not.toBeNull();
    const completed = { ...response('publishNowResult').schedule, status: 'COMPLETED', endedAt: '2026-11-04T10:06:00.000Z' };
    expect(parseManagedScheduleView(completed)).not.toBeNull();

    const active = response('acceptedResult').schedule;
    expect(parseManagedScheduleView({ ...active, endRequestedOperationKey: first, endRequestedAt: '2026-11-04T10:00:00.000Z' })).toBeNull();
    expect(parseManagedScheduleView({ ...again, ...noEndRequest })).toBeNull();
    expect(parseManagedScheduleView({ ...again, endRequestedAt: null })).toBeNull();
    expect(parseManagedScheduleView({ ...again, lastOccurrence: 6 })).toBeNull();
    expect(parseManagedScheduleView({ ...cancelled, ...noEndRequest, lastOccurrence: 6 })).toBeNull();
    expect(parseManagedScheduleView({ ...cancelled, endedOperationKey: null })).toBeNull();
    expect(parseManagedScheduleView({ ...cancelled, endedAt: '2026-11-04T09:59:00.000Z' })).toBeNull();
    expect(parseManagedScheduleView({ ...completed, endRequestedOperationKey: first, endRequestedAt: '2026-11-04T10:01:00.000Z' })).toBeNull();
    expect(parseManagedScheduleView({ ...completed, endedOperationKey: 'fixture:publish-now:0001' })).toBeNull();
  });

  it('cancels an ENDING series with an earlier pending and future occurrences up to lastOccurrence', () => {
    const schedule = response('cancelRemainingPendingResult').schedule;
    const dispatches = [response('dispatchPublished'), pendingOccurrence1()];
    const scope = lifecycleCancelScope(schedule, dispatches, 'REMAINING', 2);
    if (typeof scope === 'string') throw new Error(scope);
    expect(scope).toEqual({ affected: [{ state: 'NOT_MATERIALIZED', occurrence: 2, dueAt: '2026-11-06T09:00:00.000Z' }], inFlight: null });
    const body = { ...fixture.requests.cancelRemainingFutureOnly.body, operationKey: 'fixture:cancel-remaining-again:0001',
      expectedScheduleVersion: schedule.scheduleVersion, fromOccurrence: 2, ...scope };
    expect(parseManagedLifecycleRequest('CANCEL', body)).not.toBeNull();
    expect(lifecycleCancelScope(schedule, dispatches, 'REMAINING', 3)).toBe('CANCEL_SCOPE_MISMATCH');
    const series = lifecycleCancelScope(schedule, dispatches, 'SERIES', null);
    if (typeof series === 'string') throw new Error(series);
    expect(series.affected.map((item) => [item.state, item.occurrence])).toEqual([['PENDING', 1], ['NOT_MATERIALIZED', 2]]);
  });

  it('answers a cancel only with a series, status, scope and lifecycle that fit together', () => {
    expect(parses('RESULT', occurrenceCancel())).toBe(true);
    const ending = { ...occurrenceCancel(), lifecycle: 'SCHEDULED' };
    Object.assign(ending.schedule, { status: 'ENDING', lastOccurrence: 2, endRequestedOperationKey: 'fixture:cancel-remaining-pending:0001',
      endRequestedAt: '2026-11-04T10:00:00.000Z' });
    ending.cancellation.series = 'ENDS_AFTER_REMAINING';
    expect(parses('RESULT', ending)).toBe(true);
    const lastOne = response('cancelSeriesAfterTruncationResult');
    lastOne.cancellation.scope = 'OCCURRENCE';
    expect(parses('RESULT', lastOne)).toBe(true);
    const unmaterialized = response('cancelSeriesAfterTruncationResult');
    unmaterialized.dispatches = [];
    expect(parses('RESULT', unmaterialized)).toBe(true);

    const refused: [string, (body: any) => void][] = [
      ['cancelRemainingPendingResult', (body) => (body.cancellation.series = 'ENDS_AFTER_IN_FLIGHT')],
      ['cancelRemainingPendingResult', (body) => (body.cancellation.series = 'CONTINUES')],
      ['cancelRemainingPendingResult', (body) => (body.cancellation.series = 'ENDED')],
      ['cancelRemainingPendingResult', (body) => (body.cancellation.cancelledOccurrences = [4, 5, 6])],
      ['cancelRemainingPendingResult', (body) => (body.cancellation.cancelledOccurrences = [3, 3, 5, 6])],
      ['cancelRemainingPendingResult', (body) => (body.cancellation.cancelledOccurrences = [3, 5, 6])],
      ['cancelRemainingPendingResult', (body) => (body.cancellation.cancelledOccurrences = [6, 5, 4, 3])],
      ['cancelRemainingPendingResult', (body) => (body.schedule.scheduleVersion = 1)],
      ['cancelRemainingPendingResult', (body) => (body.schedule.scheduleGeneration = 2)],
      ['cancelRemainingPendingResult', (body) => (body.dispatches = [pendingOccurrence1()])],
      ['cancelRemainingResult', (body) => (body.lifecycle = 'SCHEDULED')],
      ['cancelRemainingResult', (body) => (body.cancellation.scope = 'OCCURRENCE')],
      ['cancelSeriesAfterTruncationResult', (body) => (body.schedule.endedOperationKey = body.schedule.endRequestedOperationKey)],
      ['cancelSeriesAfterTruncationResult', (body) => (body.dispatches[0].cancelledByOperationKey = 'fixture:cancel-other:0001')],
      ['cancelSeriesAfterTruncationResult', (body) => (body.dispatches[0].occurrence = 2)],
      ['cancelSeriesAfterTruncationResult', (body) => body.dispatches.push(clone(body.dispatches[0]))],
      ['cancelSeriesAfterTruncationResult', (body) => (body.schedule.lastOccurrence = 2)],
      ['cancelSeriesAfterTruncationResult', (body) => (body.lifecycle = 'SCHEDULED')],
    ];
    for (const [name, change] of refused) {
      const body = response(name); change(body);
      expect([name, parses('RESULT', body)]).toEqual([name, false]);
    }
    const withoutDispatch = occurrenceCancel(); withoutDispatch.dispatches = [];
    expect(parses('RESULT', withoutDispatch)).toBe(false);
    const notLast = response('cancelSeriesAfterTruncationResult');
    Object.assign(notLast.cancellation, { scope: 'OCCURRENCE' }); notLast.schedule.lastOccurrence = 2;
    expect(parses('RESULT', notLast)).toBe(false);
    const continuesEnding = occurrenceCancel(); continuesEnding.schedule.status = 'ENDING';
    expect(parses('RESULT', continuesEnding)).toBe(false);
  });

  it('answers a delete only for the schedule it superseded, without fabricated cancels or publication', () => {
    expect(parses('RESULT', response('deleteAfterTruncationResult'))).toBe(true);
    const completed = response('deleteDraftResult');
    Object.assign(completed, { managedPostId: '00000000-0000-4000-8001-000000000002', scheduleGeneration: 1,
      schedule: { ...response('publishNowResult').schedule, status: 'COMPLETED', endedAt: '2026-11-04T10:06:00.000Z' } });
    completed.deletion.wasPublished = true;
    expect(parses('RESULT', completed)).toBe(true);

    const refused: [string, (body: any) => void][] = [
      ['deleteAfterTruncationResult', (body) => (body.deletion.cancelledOccurrences = [])],
      ['deleteAfterTruncationResult', (body) => (body.deletion.cancelledOccurrences = [1, 3])],
      ['deleteAfterTruncationResult', (body) => (body.deletion.cancelledOccurrences = [1, 2, 3])],
      ['deleteAfterTruncationResult', (body) => (body.schedule.endedOperationKey = 'fixture:delete-other:0001')],
      ['deleteAfterTruncationResult', (body) => Object.assign(body.schedule, { status: 'ENDING', endedAt: null, endedOperationKey: null })],
      ['deleteAfterTruncationResult', (body) => (body.dispatches[0].status = 'PENDING')],
      ['deleteAfterTruncationResult', (body) => (body.schedule = null)],
      ['deleteDraftResult', (body) => (body.deletion.wasPublished = true)],
      ['deleteDraftResult', (body) => (body.deletion.cancelledOccurrences = [0])],
    ];
    for (const [name, change] of refused) {
      const body = response(name); change(body);
      expect([name, parses('RESULT', body)]).toEqual([name, false]);
    }
    completed.deletion.wasPublished = false;
    expect(parses('RESULT', completed)).toBe(false);
  });

  it('keeps a post SCHEDULED while its schedule is live, apart from the admission row state', () => {
    expect(lifecycleWhileScheduled(['PUBLISHED', 'PENDING'])).toBe('SCHEDULED');
    expect(lifecycleWhileScheduled(['PUBLISHED', 'ADMITTED'])).toBe('DISPATCHING');
    expect(lifecycleWhileScheduled(['UNKNOWN'])).toBe('REVIEW');
    expect(lifecycleAdmissionRowState(['PUBLISHED'])).toBe('PUBLISHED');

    const view = clone(fixture.responses.eventsPage.body.events[0].projection);
    view.dispatches = [response('dispatchPublished'), pendingOccurrence1()];
    expect(parses('LIFECYCLE', view)).toBe(true);
    expect(parses('LIFECYCLE', { ...view, lifecycle: 'PUBLISHED' })).toBe(false);
    expect(parses('LIFECYCLE', { ...response('lifecycleEnding'), lifecycle: 'SCHEDULED' })).toBe(false);
    const halted = response('lifecycleEnding');
    Object.assign(halted.schedule, { status: 'HALTED', endedAt: '2026-11-04T09:20:00.000Z' });
    halted.dispatches = [];
    expect(parses('LIFECYCLE', { ...halted, lifecycle: 'FAILED' })).toBe(true);
    expect(parses('LIFECYCLE', { ...halted, lifecycle: 'SCHEDULED' })).toBe(false);
    const tombstone = response('lifecycleTombstone');
    expect(parses('LIFECYCLE', { ...tombstone, deletion: { ...tombstone.deletion, operationKey: 'fixture:delete-other:0001' } })).toBe(false);
    const liveTombstone = response('lifecycleTombstone');
    Object.assign(liveTombstone.schedule, { status: 'ACTIVE', endedAt: null, endedOperationKey: null });
    liveTombstone.dispatches = [];
    expect(parses('LIFECYCLE', liveTombstone)).toBe(false);
  });

  it('never answers a lookup whose current generation is older than its result', () => {
    const lookup = response('lookupCommitted');
    expect(parses('OPERATION', { ...lookup, ack: 'SUPERSEDED', currentScheduleGeneration: 2 })).toBe(true);
    expect(parses('OPERATION', { ...lookup, ack: 'SUPERSEDED', currentScheduleGeneration: 0 })).toBe(false);
  });

  it('binds the cover size and type with the media in the release preview and its hash input', () => {
    for (const name of ['releasePreview', 'releasePreviewParagraph']) {
      const preview = parseManagedLifecycleResponse('RELEASE_PREVIEW', fixture.responses[name].body);
      expect(releaseHashInput(preview)).toEqual(fixture.hashInputs[name]);
    }
    const cover = (change: (thumbnail: any) => void) => {
      const body = response('releasePreviewParagraph'); change(body.members[0].media[0].thumbnail);
      return parses('RELEASE_PREVIEW', body);
    };
    expect(cover((thumbnail) => (thumbnail.mimeType = null))).toBe(true);
    expect(cover((thumbnail) => delete thumbnail.byteLength)).toBe(false);
    expect(cover((thumbnail) => delete thumbnail.mimeType)).toBe(false);
    expect(cover((thumbnail) => (thumbnail.byteLength = -1))).toBe(false);
    expect(cover((thumbnail) => (thumbnail.byteLength = 1.5))).toBe(false);
    expect(cover((thumbnail) => (thumbnail.mimeType = 'IMAGE/JPEG'))).toBe(false);
  });

  it('hashes exactly the frozen payload and affected-scope inputs', () => {
    const schedule = fixture.requests.scheduleRepeat;
    expect(lifecyclePayloadInput('SCHEDULE', schedule.target, schedule.body)).toEqual(fixture.hashInputs.scheduleRepeatPayload);
    expect(lifecycleAffectedHashInput('REMAINING', fixture.requests.cancelRemainingFutureOnly.body))
      .toEqual(fixture.hashInputs.cancelRemainingAffected);
  });
});
