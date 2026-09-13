import {Client} from 'pg';

export function getSafeDatabaseConfig(env=process.env){
  const environment=env.DB_ENV;
  if(!['development','test'].includes(environment)||env.ALLOW_DB_INTEGRATION_TESTS!=='true'){
    throw new Error('Refusing database integration work: set DB_ENV=development|test and ALLOW_DB_INTEGRATION_TESTS=true');
  }
  const connectionString=env.DATABASE_URL_TEST||env.DATABASE_URL_DEV;
  if(!connectionString)throw new Error('Missing DATABASE_URL_TEST or DATABASE_URL_DEV');
  if(/production|prod/i.test(env.DATABASE_NAME||''))throw new Error('Refusing database target marked as production');
  return {environment,connectionString};
}

export async function withSafeClient(env=process.env,operation){
  const config=getSafeDatabaseConfig(env),client=new Client({connectionString:config.connectionString});
  await client.connect();
  try{return await operation(client,config);}finally{await client.end();}
}
