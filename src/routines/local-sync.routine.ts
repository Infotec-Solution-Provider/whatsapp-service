import localSyncService from "../services/local-sync.service";


/**
 * Rotina de sincronização dos dados locais
 * Pode ser executada manualmente ou via cron job
 */
export async function runLocalSyncRoutine() {
  console.log(`[Routine] Iniciando rotina de sincronização local - ${new Date().toISOString()}`);

  try {
    await localSyncService.syncAllInstances();
    console.log(`[Routine] Rotina de sincronização concluída com sucesso`);
  } catch (error) {
    console.error(`[Routine] Erro na rotina de sincronização:`, error);
    throw error;
  }
}

/**
 * Rotina de sincronização para uma instância específica
 */
export async function runLocalSyncRoutineForInstance(instance: string) {
  console.log(`[Routine] Iniciando rotina de sincronização para instância ${instance} - ${new Date().toISOString()}`);

  try {
    await localSyncService.syncInstance(instance);
    console.log(`[Routine] Rotina de sincronização da instância ${instance} concluída com sucesso`);
  } catch (error) {
    console.error(`[Routine] Erro na rotina de sincronização da instância ${instance}:`, error);
    throw error;
  }
}

// Se executado diretamente
if (require.main === module) {
  const instance = process.argv[2];

  if (instance) {
    runLocalSyncRoutineForInstance(instance)
      .then(() => {
        console.log("Sincronização concluída!");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Falha na sincronização:", error);
        process.exit(1);
      });
  } else {
    runLocalSyncRoutine()
      .then(() => {
        console.log("Sincronização concluída!");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Falha na sincronização:", error);
        process.exit(1);
      });
  }
}
