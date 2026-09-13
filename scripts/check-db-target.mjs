import {withSafeClient} from './db-target.mjs';
try{await withSafeClient(process.env,async client=>{const r=await client.query('SELECT current_database() AS database, current_user AS user, version() AS version');console.log(JSON.stringify({environment:process.env.DB_ENV,database:r.rows[0].database,user:r.rows[0].user,postgresMajor:r.rows[0].version.match(/PostgreSQL (\d+)/)?.[1]??'unknown'}));});}
catch(error){console.error(`DB target check failed: ${error.message}`);process.exitCode=1;}
