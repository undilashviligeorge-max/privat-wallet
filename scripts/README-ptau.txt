Groth16 trusted setup (one-time per machine; ~2–4 minutes):

  cd TelegramMixer
  npx snarkjs powersoftau new bn128 12 pot12_0000.ptau -v
  npx snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau --name=First -v -e="your-entropy-string"
  npx snarkjs powersoftau prepare phase2 pot12_0001.ptau pot12_final.ptau -v

Then:

  npm run build:groth16

Pot files are gitignored except you may commit `pot12_final.ptau` for CI (~MB).
