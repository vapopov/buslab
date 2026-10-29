import test from 'node:test';
import assert from 'node:assert/strict';
import {highlightJavaScript} from '../script-highlight.mjs';

test('JavaScript comments, keywords, numbers and strings have separate tokens', () => {
  const result=highlightJavaScript('// upload\nconst addr = 0x20; await i2c.write(addr, ["PBMs", 4]);');
  for(const token of ['comment','keyword','number','string','function']) assert.match(result,new RegExp(`class="token ${token}"`));
});
test('template interpolation and regex literals are highlighted', () => {
  const result=highlightJavaScript('const value = `Read ${file.length}`; /APP\\s/.test(value);');
  for(const token of ['template-string','interpolation','regex']) assert.match(result,new RegExp(`token ${token}`));
});
test('source containing markup is escaped for the editor mirror', () => {
  const result=highlightJavaScript('const html = "<img src=x onerror=alert(1)>"; // <script>&');
  assert.doesNotMatch(result,/<img|<script>/);
  assert.match(result,/&lt;img/); assert.match(result,/&amp;/);
});
