const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const DATA_PATH = path.join(__dirname, '..', 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'frontend');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const sessions = new Map();

const DEFAULT_TEAMS = [
  {
    id: 'team-default',
    name: 'Vibe Coding Lab',
    code: 'VIBE-TEAM',
    description: '기본 팀 코드입니다. 환경설정에서 수정하세요.',
    departments: ['경영기획', '고객사업', '브랜드상품전략', '마케팅', '경영지원']
  }
];

function ensureDataFile() {
  if (!fs.existsSync(DATA_PATH)) {
    const initial = {
      teams: DEFAULT_TEAMS,
      users: [],
      restaurants: [],
      reviews: []
    };
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readDatabase() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeDatabase(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const iterations = 310000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return { salt, hash, iterations };
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const { salt, hash, iterations } = stored;
  const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
}

function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const record = sessions.get(token);
  if (!record) return null;
  if (Date.now() - record.createdAt > TOKEN_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return record;
}

function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  return getSession(token);
}

function requireAuth(req, res) {
  const session = authenticate(req);
  if (!session) {
    sendJson(res, 401, { message: '인증이 필요합니다.' });
    return null;
  }
  return session;
}

function sanitizeUser(user) {
  const { password, ...rest } = user;
  return rest;
}

function calculateRestaurantSummary(db, restaurant) {
  const reviews = db.reviews.filter(r => r.restaurantId === restaurant.id);
  const users = new Map(db.users.map(u => [u.id, u]));
  const overall = {
    reviewCount: reviews.length,
    averageRating: reviews.length
      ? Number((reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(2))
      : 0
  };

  const departments = {};
  for (const review of reviews) {
    const user = users.get(review.userId);
    const department = (user && user.department) || '기타';
    if (!departments[department]) {
      departments[department] = {
        department,
        reviewCount: 0,
        averageRating: 0,
        latestReview: null
      };
    }
    const bucket = departments[department];
    bucket.reviewCount += 1;
    bucket.averageRating += review.rating || 0;
    if (!bucket.latestReview || new Date(bucket.latestReview.createdAt) < new Date(review.createdAt)) {
      bucket.latestReview = {
        rating: review.rating,
        shortComment: review.shortComment,
        comment: review.comment,
        createdAt: review.createdAt,
        authorName: user ? user.displayName : '알 수 없음'
      };
    }
  }
  for (const key of Object.keys(departments)) {
    const bucket = departments[key];
    bucket.averageRating = Number((bucket.averageRating / bucket.reviewCount).toFixed(2));
  }

  let latestReview = null;
  if (reviews.length > 0) {
    latestReview = reviews
      .map(review => {
        const author = users.get(review.userId);
        return {
          id: review.id,
          rating: review.rating,
          shortComment: review.shortComment,
          comment: review.comment,
          createdAt: review.createdAt,
          department: author ? author.department : '기타',
          authorName: author ? author.displayName : '알 수 없음'
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  }

  return {
    ...restaurant,
    ...overall,
    departments,
    latestReview
  };
}

function getRequestBody(req) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    return parseBody(req);
  }
  return Promise.resolve({});
}

function serveStaticFile(req, res, pathname) {
  const baseDir = path.resolve(PUBLIC_DIR);
  if (!fs.existsSync(baseDir)) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const sanitizedPath = pathname.replace(/^\/+/, '');
  let filePath = path.resolve(path.join(baseDir, sanitizedPath));
  if (!filePath.startsWith(baseDir)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.createReadStream(filePath)
    .on('error', () => sendText(res, 500, 'Internal Server Error'))
    .once('open', () => {
      res.writeHead(200, { 'Content-Type': contentType });
    })
    .pipe(res);
}

function handleAuthRoutes(req, res, pathname, db) {
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const { username, password, teamCode, displayName, department } = body;
        if (!username || !password || !teamCode) {
          sendJson(res, 400, { message: '아이디, 비밀번호, 팀 코드는 필수입니다.' });
          return;
        }
        const team = db.teams.find(t => t.code === teamCode);
        if (!team) {
          sendJson(res, 400, { message: '유효하지 않은 팀 코드입니다.' });
          return;
        }
        const normalizedUsername = String(username).trim().toLowerCase();
        if (db.users.some(u => u.username === normalizedUsername)) {
          sendJson(res, 409, { message: '이미 사용 중인 아이디입니다.' });
          return;
        }
        const passwordRecord = hashPassword(password);
        const user = {
          id: crypto.randomUUID(),
          username: normalizedUsername,
          displayName: displayName ? String(displayName).trim() : normalizedUsername,
          department: department || '기타',
          teamId: team.id,
          createdAt: new Date().toISOString(),
          password: passwordRecord
        };
        db.users.push(user);
        writeDatabase(db);
        const token = createToken(user.id);
        sendJson(res, 201, { token, user: sanitizeUser(user) });
      })
      .catch(err => {
        sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' });
      });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const { username, password } = body;
        if (!username || !password) {
          sendJson(res, 400, { message: '아이디와 비밀번호를 입력하세요.' });
          return;
        }
        const normalizedUsername = String(username).trim().toLowerCase();
        const user = db.users.find(u => u.username === normalizedUsername);
        if (!user || !verifyPassword(password, user.password)) {
          sendJson(res, 401, { message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
          return;
        }
        const token = createToken(user.id);
        sendJson(res, 200, { token, user: sanitizeUser(user) });
      })
      .catch(err => sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' }));
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    const user = db.users.find(u => u.id === session.userId);
    if (!user) {
      sendJson(res, 401, { message: '세션이 만료되었습니다.' });
      return;
    }
    sendJson(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = authenticate(req);
    if (session) {
      const authHeader = req.headers['authorization'];
      const token = authHeader.slice(7);
      sessions.delete(token);
    }
    sendJson(res, 200, { message: '로그아웃 되었습니다.' });
    return;
  }

  return false;
}

function handleMetaRoutes(req, res, pathname, db) {
  if (pathname === '/api/meta/departments' && req.method === 'GET') {
    const departments = Array.from(new Set(db.teams.flatMap(team => team.departments || [])));
    sendJson(res, 200, { departments });
    return true;
  }
  if (pathname === '/api/meta/teams' && req.method === 'GET') {
    const publicTeams = db.teams.map(team => ({
      id: team.id,
      name: team.name,
      description: team.description,
      departments: team.departments
    }));
    sendJson(res, 200, { teams: publicTeams });
    return true;
  }
  return false;
}

function handleRestaurantRoutes(req, res, pathname, db) {
  if (!pathname.startsWith('/api/restaurants')) {
    return false;
  }
  const session = requireAuth(req, res);
  if (!session) return true;
  const user = db.users.find(u => u.id === session.userId);
  if (!user) {
    sendJson(res, 401, { message: '사용자 정보를 찾을 수 없습니다.' });
    return true;
  }
  const teamId = user.teamId;
  const parsedUrl = url.parse(req.url, true);

  if (pathname === '/api/restaurants' && req.method === 'GET') {
    const list = db.restaurants
      .filter(rest => rest.teamId === teamId)
      .map(rest => calculateRestaurantSummary(db, rest));
    sendJson(res, 200, { restaurants: list });
    return true;
  }

  if (pathname === '/api/restaurants' && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const { name, address, lat, lng, category, description } = body;
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (!name || Number.isNaN(latitude) || Number.isNaN(longitude)) {
          sendJson(res, 400, { message: '이름과 위도/경도를 확인해주세요.' });
          return;
        }
        const restaurant = {
          id: crypto.randomUUID(),
          teamId,
          name: String(name).trim(),
          address: address ? String(address).trim() : '',
          lat: latitude,
          lng: longitude,
          category: category ? String(category).trim() : '',
          description: description ? String(description).trim() : '',
          createdBy: user.id,
          createdAt: new Date().toISOString()
        };
        db.restaurants.push(restaurant);
        writeDatabase(db);
        sendJson(res, 201, { restaurant: calculateRestaurantSummary(db, restaurant) });
      })
      .catch(err => sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' }));
  }

  const restaurantMatch = pathname.match(/^\/api\/restaurants\/([^/]+)$/);
  if (restaurantMatch && req.method === 'GET') {
    const restaurantId = restaurantMatch[1];
    const restaurant = db.restaurants.find(r => r.id === restaurantId && r.teamId === teamId);
    if (!restaurant) {
      sendJson(res, 404, { message: '맛집을 찾을 수 없습니다.' });
      return true;
    }
    const users = new Map(db.users.map(u => [u.id, u]));
    const reviews = db.reviews
      .filter(r => r.restaurantId === restaurantId)
      .map(review => {
        const reviewer = users.get(review.userId);
        return {
          id: review.id,
          rating: review.rating,
          shortComment: review.shortComment,
          comment: review.comment,
          createdAt: review.createdAt,
          authorId: review.userId,
          authorName: reviewer ? reviewer.displayName : '알 수 없음',
          department: reviewer ? reviewer.department : '기타'
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const payload = {
      restaurant: calculateRestaurantSummary(db, restaurant),
      reviews
    };
    sendJson(res, 200, payload);
    return true;
  }

  const reviewMatch = pathname.match(/^\/api\/restaurants\/([^/]+)\/reviews$/);
  if (reviewMatch && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const restaurantId = reviewMatch[1];
        const restaurant = db.restaurants.find(r => r.id === restaurantId && r.teamId === teamId);
        if (!restaurant) {
          sendJson(res, 404, { message: '맛집을 찾을 수 없습니다.' });
          return;
        }
        const { rating, shortComment, comment } = body;
        const numericRating = Number(rating);
        if (!numericRating || numericRating < 1 || numericRating > 5) {
          sendJson(res, 400, { message: '평점은 1에서 5 사이의 숫자여야 합니다.' });
          return;
        }
        const review = {
          id: crypto.randomUUID(),
          restaurantId,
          userId: user.id,
          rating: numericRating,
          shortComment: shortComment ? String(shortComment).slice(0, 120) : '',
          comment: comment ? String(comment).slice(0, 2000) : '',
          createdAt: new Date().toISOString()
        };
        db.reviews.push(review);
        writeDatabase(db);
        const users = new Map(db.users.map(u => [u.id, u]));
        const reviewer = users.get(user.id);
        sendJson(res, 201, {
          review: {
            id: review.id,
            rating: review.rating,
            shortComment: review.shortComment,
            comment: review.comment,
            createdAt: review.createdAt,
            authorId: reviewer ? reviewer.id : user.id,
            authorName: reviewer ? reviewer.displayName : '나',
            department: reviewer ? reviewer.department : '기타'
          },
          restaurant: calculateRestaurantSummary(db, restaurant)
        });
      })
      .catch(err => sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' }));
  }

  return true;
}

const server = http.createServer((req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname || '/';

    // remove trailing slash except root
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    const db = readDatabase();

    // API Routes
    if (pathname.startsWith('/api/')) {
      if (handleAuthRoutes(req, res, pathname, db) !== false) return;
      if (handleMetaRoutes(req, res, pathname, db)) return;
      if (handleRestaurantRoutes(req, res, pathname, db)) return;
      sendJson(res, 404, { message: '요청한 API를 찾을 수 없습니다.' });
      return;
    }

    // Static assets
    if (req.method === 'GET') {
      const staticPath = pathname === '/' ? '/index.html' : pathname;
      try {
        serveStaticFile(req, res, staticPath);
      } catch (err) {
        console.error('Static file error:', err);
        sendText(res, 500, 'Internal Server Error');
      }
      return;
    }

    sendText(res, 405, 'Method Not Allowed');
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { message: '서버 오류가 발생했습니다.' });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
