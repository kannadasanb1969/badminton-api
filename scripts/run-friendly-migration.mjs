import {readFile} from 'node:fs/promises';
import {withSafeClient} from './db-target.mjs';
const migrationFile=process.env.FRIENDLY_MIGRATION_FILE||'../migrations/20260913_friendly_match_domain.sql';
const sql=await readFile(new URL(migrationFile,import.meta.url),'utf8');
try{await withSafeClient(process.env,async client=>{await client.query('BEGIN');try{await client.query(sql);await client.query('COMMIT');console.log(`Friendly migration applied to ${process.env.DB_ENV} database target`);}catch(error){await client.query('ROLLBACK');throw error;}});}
catch(error){console.error(`Friendly migration failed: ${error.message}`);process.exitCode=1;}
