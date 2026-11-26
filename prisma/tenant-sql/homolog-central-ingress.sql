-- Homolog only. Separate receipt identity and content so a confirmed handoff removes the payload.
CREATE TABLE IF NOT EXISTS homolog_ingress_routes (
  provider ENUM('WABA','GUPSHUP','REMOTE') NOT NULL,
  instance VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  client_id INT NOT NULL,
  route_hash BINARY(32) NOT NULL,
  PRIMARY KEY(provider,instance,client_id),
  KEY ingress_route_lookup(provider,route_hash,instance)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ingress_waba (
  seq BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id CHAR(36) CHARACTER SET ascii NOT NULL,
  instance VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  client_id INT NOT NULL,
  event_key BINARY(32) NOT NULL,
  transport_key BINARY(32) NOT NULL,
  payload_hash BINARY(32) NOT NULL,
  payload JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  UNIQUE KEY event_identity(instance,client_id,event_key),
  UNIQUE KEY transport_identity(instance,client_id,transport_key),
  UNIQUE KEY receipt_id(id),
  KEY pending_handoff(instance,delivered_at,seq)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ingress_gupshup LIKE ingress_waba;
CREATE TABLE IF NOT EXISTS ingress_remote LIKE ingress_waba;
