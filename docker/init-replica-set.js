// Idempotent: safe to run on every `docker-compose up`.
// The member host is "localhost" because the app connects from the host machine
// with directConnection=true; the replica set only needs to be a valid single node.
try {
  rs.status();
  print('replica set already initiated');
} catch (e) {
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] });
  print('replica set initiated');
}
