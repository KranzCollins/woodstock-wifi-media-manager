// The canonical caption vectors W&W encodes against, checked with the REAL
// editor sanitizer (DOMPurify on jsdom) and the real plain-text helpers;
// nothing here is mocked
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  postContentPlainText,
  sanitizePostContent,
} from '@gitroom/helpers/utils/sanitize.post.content';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'canonical.caption.vectors.json'), 'utf8')
);

const CODECS = ['ww-plain-escape-v1', 'ww-plain-paragraph-escape-v1'] as const;

// the codec, written out from the fixture's own declaration
const encode = (codec: (typeof CODECS)[number], plain: string) => {
  const { escapes, wrapper } = fixture.codecs[codec];
  const escaped = [...plain].map((char) => escapes[char] ?? char).join('');
  return wrapper ? `${wrapper[0]}${escaped}${wrapper[1]}` : escaped;
};

describe('canonical caption vectors (real sanitizer)', () => {
  it('declares exactly the escapes the sanitizer serializer makes', () => {
    for (const codec of CODECS) {
      expect(fixture.codecs[codec].escapes).toEqual({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\u{a0}': '&nbsp;',
      });
      expect(fixture.codecs[codec].quotes).toBe('LITERAL');
      expect(fixture.codecs[codec].newlines).toBe('LITERAL_LF');
    }
  });

  // U+00A0 is stored literally in the JSON; an editor turning it into a space
  // would silently drop the vector
  it('keeps the no-break space vector a real U+00A0', () => {
    const vector = fixture.vectors.find((item: any) => item.name === 'no-break space');
    expect(vector.plain).toBe('non\u{a0}breaking');
    expect(vector.providerTextNormal['ww-plain-paragraph-escape-v1']).toBe('non breaking');
    expect(fixture.notFixedPoints[2].html).toBe('<p>non\u{a0}breaking</p>');
  });

  describe.each(fixture.vectors.map((vector: any) => [vector.name, vector]))(
    '%s',
    (_name, vector: any) => {
      it.each(CODECS)('%s is the encoding of the plain text', (codec) => {
        expect(vector[codec]).toBe(encode(codec, vector.plain));
      });

      it.each(CODECS)('%s is a sanitizer fixed point', (codec) => {
        expect(sanitizePostContent(vector[codec])).toBe(vector[codec]);
      });

      it.each(CODECS)('%s decodes back to the exact plain text', (codec) => {
        expect(postContentPlainText(vector[codec])).toBe(vector.plain);
      });

      it('gives providers the recorded text', () => {
        for (const [codec, text] of Object.entries(vector.providerTextNormal || {})) {
          expect([codec, stripHtmlValidation('normal', vector[codec])]).toEqual([codec, text]);
        }
      });
    }
  );

  it('parses the paragraph form, so a carriage return is not a fixed point', () => {
    const [carriageReturn] = fixture.refusedInput;
    expect(carriageReturn.name).toBe('carriage return');
    const paragraph = encode('ww-plain-paragraph-escape-v1', carriageReturn.plain);
    expect(sanitizePostContent(paragraph)).toBe(carriageReturn.paragraphSanitized);
    expect(sanitizePostContent(paragraph)).not.toBe(paragraph);
  });

  it.each(fixture.notFixedPoints.map((item: any) => [item.html, item.sanitized]))(
    'refuses %j as it is: the sanitizer makes it %j',
    (html, sanitized) => {
      expect(sanitizePostContent(html)).toBe(sanitized);
      expect(sanitized).not.toBe(html);
    }
  );

  it.each(fixture.taglessPassThrough.map((item: any) => [item.html, item.sanitized]))(
    'passes tagless %j through unparsed, so the gate cannot see a missing escape',
    (html, sanitized) => {
      expect(sanitizePostContent(html)).toBe(sanitized);
      expect(sanitized).toBe(html);
    }
  );
});
