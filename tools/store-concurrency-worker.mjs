const loops = Math.max(1, Number(process.argv[2] || 1));
const { updateDb } = await import('../server/store.ts');

for (let index = 0; index < loops; index += 1) {
  updateDb((db) => {
    db.concurrencyVerifyCount = Number(db.concurrencyVerifyCount || 0) + 1;
  });
}
