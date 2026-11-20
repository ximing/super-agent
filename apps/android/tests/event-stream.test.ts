import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consumeEventStream} from '../src/event-stream';

test('event stream keeps the cursor, skips a duplicate seq, and applies the newer one', () => {
  const fixture = [
    'id: 4',
    'event: task.changed',
    'data: {"event_id":"e4","stream_seq":"4","type":"task.changed","task_id":"task-a"}',
    '',
    '%%%',
    '',
    'id: 5',
    'event: task.changed',
    'data: {"event_id":"e5","stream_seq":"5","type":"task.changed","task_id":"task-b"}',
    '',
  ].join('\n') + '\n';
  const cut = fixture.indexOf('"stream_seq":"5"') + 4;
  const first = consumeEventStream(fixture.slice(0, cut), '4');
  assert.equal(first.cursor, '4');
  assert.deepEqual(first.applied, []);
  const second = consumeEventStream(fixture.slice(cut), first.cursor, first.seen, first.remainder);
  assert.deepEqual(second.applied.map(event => event.streamSeq), ['5']);
  assert.equal(second.cursor, '5');
  assert.equal(second.applied[0]?.eventId, 'e5');
  assert.equal(second.applied[0]?.taskId, 'task-b');
  const replay = consumeEventStream(fixture, second.cursor, second.seen);
  assert.deepEqual(replay.applied, []);
  assert.equal(replay.cursor, '5');
});
