#!/usr/bin/env node
// card-tools: dependency-free CLI for building, validating, inspecting and
// packaging Autolife character cards (chara_card_v3 + data.extensions.autolife).
//
//   node tools/card-tools.mjs create --name "Maya" --template busy-friend --out maya.json
//   node tools/card-tools.mjs embed maya.json --avatar pic.png -o Maya.png
//   node tools/card-tools.mjs embed maya.json -o Maya.png          (placeholder avatar)
//   node tools/card-tools.mjs validate Maya.png maya.json
//   node tools/card-tools.mjs inspect Maya.png
//   node tools/card-tools.mjs list-templates

import fs from 'node:fs';
import path from 'node:path';
import { extractCardFromPng, embedCardInPng, purgeCardFromPng, generatePlaceholderAvatar } from '../plugin/src/card-io.js';
import { validateCard } from '../plugin/src/autolife-schema.js';
import { TEMPLATES, buildFromTemplate } from './templates.mjs';

function usage(code = 0) {
    console.log(`Usage: card-tools <command> [options]

Commands:
  create --name <name> --template <t> [--tz <tz>] [--out <file.json>]
  embed <card.json> [image.png] [-o <out.png>]
                                (pack the card into an existing image, IN PLACE
                                 unless -o given; placeholder avatar if no image)
  purge <image.png> [-o <out.png>]
                                (strips ALL card data; in place unless -o given)
  validate <file...>        (.png or .json cards)
  inspect <file>
  list-templates`);
    process.exit(code);
}

function arg(name, fallback = undefined) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readCardFile(file) {
    const buffer = fs.readFileSync(file);
    if (file.toLowerCase().endsWith('.json')) return JSON.parse(buffer.toString('utf8'));
    return extractCardFromPng(buffer).card;
}

const command = process.argv[2];

switch (command) {
    case 'list-templates': {
        for (const [name, t] of Object.entries(TEMPLATES)) {
            console.log(`${name.padEnd(14)} ${t.description}`);
        }
        break;
    }

    case 'create': {
        const name = arg('--name');
        const template = arg('--template');
        if (!name || !template) usage(1);
        if (!TEMPLATES[template]) {
            console.error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
            process.exit(1);
        }
        const card = buildFromTemplate(template, name, { timezone: arg('--tz') });
        const out = arg('--out', `cards/${name.toLowerCase().replace(/\s+/g, '-')}.json`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(card, null, 4), 'utf8');
        const check = validateCard(card);
        console.log(`Created ${out} (${check.valid ? 'valid' : 'INVALID: ' + check.errors.join('; ')})`);
        if (!check.valid) process.exit(1);
        break;
    }

    case 'embed': {
        const cardFile = process.argv[3];
        if (!cardFile) usage(1);
        const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
        // positional image (embed <card.json> <image.png>) or the --avatar flag
        const flagValuePositions = new Set();
        for (let i = 0; i < process.argv.length; i++) {
            if (['--avatar', '-o', '--out'].includes(process.argv[i])) flagValuePositions.add(i + 1);
        }
        const positional = process.argv.slice(4).filter((a, i) => !a.startsWith('-') && !flagValuePositions.has(4 + i));
        const imageFile = positional[0] ?? arg('--avatar');
        // embedding into an existing image defaults to in place
        const out = arg('-o') ?? arg('--out') ?? imageFile;
        if (!out) {
            console.error('Need an existing image to embed into (in place), or -o <out.png> for a placeholder avatar.');
            process.exit(1);
        }
        const name = card?.data?.name ?? 'character';
        const base = imageFile ? fs.readFileSync(imageFile) : generatePlaceholderAvatar(name);
        const png = embedCardInPng(base, card);
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, png);
        // round-trip check
        const back = extractCardFromPng(png).card;
        if (back?.data?.name !== card?.data?.name) {
            console.error('Round-trip verification FAILED');
            process.exit(1);
        }
        const inPlace = out === imageFile;
        console.log(`Wrote ${out} (${(png.length / 1024).toFixed(0)} KB, card: ${name}${imageFile ? inPlace ? ', embedded in place' : ', from ' + imageFile : ', placeholder avatar'})`);
        break;
    }

    case 'purge': {
        const file = process.argv[3];
        if (!file || !file.toLowerCase().endsWith('.png')) {
            console.error('Usage: purge <image.png> [-o <out.png>]');
            process.exit(1);
        }
        const out = arg('-o') ?? arg('--out') ?? file;
        const cleaned = purgeCardFromPng(fs.readFileSync(file));
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, cleaned);
        let cardGone = true;
        try {
            extractCardFromPng(cleaned);
            cardGone = false;
        } catch { /* expected: no card left */ }
        console.log(`Purged card data -> ${out} (${(cleaned.length / 1024).toFixed(0)} KB, ${cardGone ? 'no card remains' : 'WARNING: a card chunk is still present'})`);
        process.exit(cardGone ? 0 : 1);
    }

    case 'validate': {
        const files = process.argv.slice(3).filter((f) => !f.startsWith('-'));
        if (!files.length) usage(1);
        let bad = 0;
        for (const file of files) {
            let card;
            try {
                card = readCardFile(file);
            } catch (err) {
                console.error(`✗ ${file}: ${err.message}`);
                bad++;
                continue;
            }
            const check = validateCard(card);
            if (check.valid) {
                console.log(`✓ ${file}${check.hasAutolife ? '' : '  (no autolife block)'}`);
                for (const w of check.warnings) console.log(`    warning: ${w}`);
            } else {
                console.error(`✗ ${file}`);
                for (const e of check.errors) console.error(`    error: ${e}`);
                for (const w of check.warnings) console.error(`    warning: ${w}`);
                bad++;
            }
        }
        process.exit(bad ? 1 : 0);
    }

    case 'inspect': {
        const file = process.argv[3];
        if (!file) usage(1);
        const card = readCardFile(file);
        const data = card?.data ?? card;
        const a = data?.extensions?.autolife;
        console.log(`name:            ${data?.name}`);
        console.log(`spec:            ${card?.spec ?? '(none — V1?)'} ${card?.spec_version ?? ''}`);
        console.log(`creator:         ${data?.creator ?? '?'} v${data?.character_version ?? '?'}`);
        console.log(`description:     ${(data?.description ?? '').slice(0, 100)}…`);
        console.log(`autolife:        ${a ? `v${a.version}, tz ${a.timezone}, ${a.schedule?.length ?? 0} schedule block(s)` : '(none)'}`);
        if (a) {
            if (a.initiative?.enabled) console.log(`initiative:      every ≥${a.initiative.min_gap_minutes}min, max ${a.initiative.max_per_day}/day`);
            console.log(`behavior:        quick ${(a.behavior?.quick_reply_chance ?? 0.5) * 100}%, delay ${a.behavior?.delay_minutes_min ?? 5}-${a.behavior?.delay_minutes_max ?? 90}min, ignore ${(a.behavior?.ignore_chance ?? 0.05) * 100}%`);
            for (const [i, b] of (a.schedule ?? []).entries()) {
                const days = (b.days ?? []).map((d) => 'SMTWTFS'[d]).join('');
                console.log(`  block ${i}:        ${days} ${b.start}-${b.end} ${b.activity} (${Math.round((b.availability ?? 0.5) * 100)}%)`);
            }
        }
        break;
    }

    default:
        usage(command ? 1 : 0);
}
