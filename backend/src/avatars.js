// Built-in chatbot avatars. Each is a square 620 px AI-generated portrait (no
// real person) with the two mouth corners measured by hand for lip-sync.
// "classic" is the original default face. To add one: put a square photo in
// public/avatars/, measure the mouth corners in its 620 px version, add a row.
const SIZE = 620;
const TEMPLATES = [
  { id: 'classic', name: 'Classic', url: '/avatar-csr.jpg', corners: [[252, 464], [372, 464]] },
  { id: 'navy', name: 'Navy suit', url: '/avatars/navy.jpg', corners: [[247, 444], [368, 445]] },
  { id: 'grey', name: 'Light grey suit', url: '/avatars/grey.jpg', corners: [[260, 367], [350, 369]] },
  { id: 'beard', name: 'Beard, charcoal suit', url: '/avatars/beard.jpg', corners: [[260, 447], [360, 451]] },
];

// Same proportions as TalkingHead.faceFromCorners in public/talking-head.js.
function faceFromCorners([lx, ly], [rx, ry], size) {
  const halfWidth = Math.max(4, Math.abs(rx - lx) / 2);
  const lipLine = (ly + ry) / 2;
  return {
    crop: { x: 0, y: 0, size },
    mouthX: Math.round((lx + rx) / 2),
    lipLine: Math.round(lipLine),
    halfWidth: Math.round(halfWidth),
    upperLipTop: Math.round(lipLine - halfWidth * 0.25),
    jawBottom: Math.round(Math.min(size, lipLine + halfWidth * 1.45)),
    maxOpen: Math.round(halfWidth * 0.28),
    liftRatio: 0.12,
    teeth: true,
  };
}

const AVATARS = TEMPLATES.map((t) => ({ id: t.id, name: t.name, url: t.url, face: faceFromCorners(t.corners[0], t.corners[1], SIZE) }));
const byId = Object.fromEntries(AVATARS.map((a) => [a.id, a]));

module.exports = { AVATARS, avatarById: (id) => byId[id] || null };
