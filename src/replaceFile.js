import path from 'node:path';
import multer from 'multer';
import { replaceJobFile } from './jobManager.js';
import { validateImportAudio } from './libraryImport.js';

const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, done) { done(null, path.dirname(req.replacementPath)); },
    filename(req, _file, done) { done(null, path.basename(req.replacementPath)); }
  }),
  limits: { fileSize: 512 * 1024 ** 2, files: 1, fields: 0, parts: 1, fieldNameSize: 100, fieldSize: 0 },
  fileFilter(req, file, done) {
    if (path.extname(file.originalname).toLowerCase() !== path.extname(req.params.name).toLowerCase()) {
      return done(failure('Replacement audio must have the same file extension and format as the original'));
    }
    done(null, true);
  }
}).single('file');

export function createReplaceFileHandler(listJobFiles) {
  return async (req, res) => {
    try {
      const result = await replaceJobFile(req.params.id, req.params.name, req.user, async (staged) => {
        if (!req.is('multipart/form-data')) throw failure('Upload one audio file using multipart field "file"');
        req.replacementPath = staged;
        await new Promise((resolve, reject) => upload(req, res, (error) => {
          if (!error) return resolve();
          if (error.code === 'LIMIT_FILE_SIZE') return reject(failure('Audio file exceeds the 512 MB limit', 413));
          if (error instanceof multer.MulterError || !error.code) error.statusCode ||= 400;
          reject(error);
        }));
        if (!req.file) throw failure('Select one replacement audio file');
        await validateImportAudio({ name: req.params.name, path: staged });
      });
      if (!result) return res.status(404).json({ error: 'Job not found' });
      const files = await listJobFiles(result.job, undefined, [req.params.name]);
      return res.json({ file: files.find((file) => file.name === req.params.name), metadata: result.metadata });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };
}
