/** Unit test for the shared profanity filter: what chat masks, what names refuse, and everyday words it must leave alone. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { maskProfanity, nameHasProfanity, validateRoomName, validateUsername } from '../src/shared';

describe('chat masking', () => {
  const masked: [string, string][] = [
    ['đm thằng này', '** thằng này'],
    ['ĐMMM', '****'],
    ['vcl quá', '*** quá'],
    ['v.c.l', '*.*.*'],
    ['đ m', '* *'],
    ['địt mẹ mày', '*** ** mày'],
    ['dit me may', '*** ** may'],
    ['con cặc', '*** ***'],
    ['lồnnn', '*****'],
    ['fuuuck you', '****** you'],
    ['d1tme luôn', '***** luôn'],
    ['Đéo chơi nữa', '*** chơi nữa'],
    ['ditmemay', '********'],
  ];
  for (const [input, want] of masked) {
    test(`masks "${input}"`, () => {
      const r = maskProfanity(input);
      assert.equal(r.text, want);
      assert.ok(r.hits > 0);
    });
  }

  test('reads words typed with decomposed marks', () => {
    assert.equal(maskProfanity('địt'.normalize('NFD')).text, '***');
  });

  const clean = [
    'các bạn ơi vào phòng đi',
    'buổi tối vui vẻ',
    'mua lon nước',
    'dù mẹ nói gì cũng chơi',
    'dm mình nhé',
    'cao 5 cm',
    'ok ạ à ừ',
    'Scunthorpe',
    'đi đâu đấy, đu dây không',
    'edit lại map đi',
    'cái lon này của ai',
  ];
  for (const input of clean) {
    test(`leaves "${input}" alone`, () => {
      assert.deepEqual(maskProfanity(input), { text: input, hits: 0 });
    });
  }
});

describe('names', () => {
  for (const name of ['DitMe123', 'con_cac', 'Cac', 'lon', 'dmm_pro', 'fuckboy', 'VCL99', 'd1tme', 'Lon_99', 'xx_dit_me']) {
    test(`refuses ${name}`, () => {
      assert.ok(nameHasProfanity(name));
      assert.ok(validateUsername(name).some((e) => e.includes('không phù hợp')));
    });
  }
  for (const name of ['Long', 'Salon', 'Cacao', 'Lona', 'Toshita', 'Edit_master', 'Tuan_Anh', 'gacon', 'DuLich', 'Fukuda']) {
    test(`accepts ${name}`, () => {
      assert.equal(nameHasProfanity(name), false);
      assert.deepEqual(validateUsername(name), []);
    });
  }

  test('room names', () => {
    assert.ok(validateRoomName('Phòng địt nhau'));
    assert.ok(validateRoomName('vcl'));
    assert.equal(validateRoomName('Phòng các bạn'), null);
    assert.equal(validateRoomName(''), null);
  });
});
