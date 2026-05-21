const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   🔥 MYSQL
========================= */

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'grocerydb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

console.log(
  '✅ Conectado a MySQL'
);

/* =========================
   🔐 LOGIN
========================= */

app.post(
  '/login',
  async (req, res) => {

    try {

      const {
        username,
        password
      } = req.body;

      const [rows] =
        await pool.query(
          `
          SELECT *
          FROM users
          WHERE Username = ?
          AND Password = ?
          `,
          [
            username,
            password
          ]
        );

      if (
        rows.length === 0
      ) {

        return res
          .status(401)
          .json({
            message:
              'Credenciales incorrectas'
          });
      }

      res.json({
        userId:
          rows[0].Id,

        username:
          rows[0].Username
      });

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  }
);

/* =========================
   🆕 REGISTER
========================= */

app.post(
  '/register',
  async (req, res) => {

    try {

      const {
        username,
        password
      } = req.body;

      if (
        !username ||
        !password
      ) {

        return res
          .status(400)
          .send(
            'Completa todos los campos'
          );
      }

      const [existing] =
        await pool.query(
          `
          SELECT *
          FROM users
          WHERE Username = ?
          `,
          [username]
        );

      if (
        existing.length > 0
      ) {

        return res
          .status(400)
          .send(
            'El usuario ya existe'
          );
      }

      const [result] =
        await pool.query(
          `
          INSERT INTO users
          (
            Username,
            Password
          )
          VALUES (?, ?)
          `,
          [
            username,
            password
          ]
        );

      res.json({
        userId:
          result.insertId,

        username
      });

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  }
);

/* =========================
   📦 PRODUCTOS
========================= */

app.get(
  '/products/:userId',
  async (req, res) => {

    try {

      const {
        userId
      } = req.params;

      const [rows] =
        await pool.query(
          `
          SELECT 
            p.Id,
            p.Name,
            p.Category,
            p.Price,
            p.Supplier,
            p.user_id,

            IFNULL(
              SUM(l.Quantity),
              0
            ) AS Stock,

            MIN(
              l.ExpirationDate
            ) AS ExpirationDate

          FROM products p

          LEFT JOIN productlots l
            ON p.Id = l.ProductId

          WHERE p.user_id = ?

          GROUP BY
            p.Id,
            p.Name,
            p.Category,
            p.Price,
            p.Supplier,
            p.user_id
          `,
          [userId]
        );

      res.json(rows);

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  }
);

/* =========================
   ➕ AGREGAR PRODUCTO
========================= */

app.post(
  '/products',
  async (req, res) => {

    try {

      const {
        Name,
        Category,
        Price,
        Stock,
        ExpirationDate,
        Supplier,
        userId
      } = req.body;

      const [existing] =
        await pool.query(
          `
          SELECT *
          FROM products
          WHERE Name = ?
          AND user_id = ?
          `,
          [Name, userId]
        );

      let productId;

      if (
        existing.length > 0
      ) {

        productId =
          existing[0].Id;

      } else {

        const [result] =
          await pool.query(
            `
            INSERT INTO products
            (
              Name,
              Category,
              Price,
              Supplier,
              user_id
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [
              Name,
              Category,
              Number(Price),
              Supplier,
              userId
            ]
          );

        productId =
          result.insertId;
      }

      await pool.query(
        `
        INSERT INTO productlots
        (
          ProductId,
          Quantity,
          ExpirationDate,
          user_id
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          productId,
          Number(Stock),
          ExpirationDate,
          userId
        ]
      );

      res.send(
        'Producto agregado'
      );

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  }
);

/* =========================
   🔄 REABASTECER
========================= */

app.post(
  '/restock',
  async (req, res) => {

    try {

      const {
        productId,
        quantity,
        expirationDate,
        userId
      } = req.body;

      await pool.query(
        `
        INSERT INTO productlots
        (
          ProductId,
          Quantity,
          ExpirationDate,
          user_id
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          Number(productId),
          Number(quantity),
          expirationDate,
          userId
        ]
      );

      res.send(
        'Reabastecido'
      );

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  }
);

/* =========================
   💰 VENTAS FIFO
========================= */

app.post(
  '/sales',
  async (req, res) => {

    const connection =
      await pool.getConnection();

    try {

      const {
        productId,
        quantity,
        userId
      } = req.body;

      const qty =
        Number(quantity);

      await connection.beginTransaction();

      const [lots] =
        await connection.query(
          `
          SELECT
            Id,
            Quantity
          FROM productlots
          WHERE ProductId = ?
          AND user_id = ?
          AND Quantity > 0
          ORDER BY ExpirationDate ASC
          `,
          [
            Number(productId),
            userId
          ]
        );

      const totalStock =
        lots.reduce(
          (sum, lot) =>
            sum +
            Number(
              lot.Quantity
            ),
          0
        );

      if (
        totalStock < qty
      ) {

        await connection.rollback();

        return res
          .status(400)
          .send(
            'Stock insuficiente'
          );
      }

      let remaining = qty;

      for (const lot of lots) {

        if (
          remaining <= 0
        ) {
          break;
        }

        const lotQty =
          Number(
            lot.Quantity
          );

        const used =
          Math.min(
            remaining,
            lotQty
          );

        const newQty =
          lotQty - used;

        await connection.query(
          `
          UPDATE productlots
          SET Quantity = ?
          WHERE Id = ?
          `,
          [
            newQty,
            lot.Id
          ]
        );

        remaining -= used;
      }

      const [product] =
        await connection.query(
          `
          SELECT Price
          FROM products
          WHERE Id = ?
          AND user_id = ?
          `,
          [
            Number(productId),
            userId
          ]
        );

      const price =
        Number(
          product[0].Price
        );

      await connection.query(
        `
        INSERT INTO sales
        (
          ProductId,
          Quantity,
          Total,
          Date,
          user_id
        )
        VALUES (?, ?, ?, NOW(), ?)
        `,
        [
          Number(productId),
          qty,
          price * qty,
          userId
        ]
      );

      await connection.commit();

      res.send(
        'Venta realizada'
      );

    } catch (err) {

      await connection.rollback();

      console.error(err);

      res
        .status(500)
        .send(err.message);

    } finally {

      connection.release();
    }
  }
);

/* =========================
   📜 HISTORIAL
========================= */

app.get(
  '/sales/:userId',
  async (req, res) => {

    try {

      const {
        userId
      } = req.params;

      const [rows] =
        await pool.query(
          `
          SELECT
            s.Id,

            p.Name
              AS ProductName,

            s.Quantity,
            s.Total,
            s.Date

          FROM sales s

          JOIN products p
            ON p.Id =
              s.ProductId

          WHERE s.user_id = ?

          ORDER BY
            s.Date DESC
          `,
          [userId]
        );

      res.json(rows);

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  }
);

/* =========================
   🚀 SERVER
========================= */

app.listen(3001, () => {

  console.log(
    '🚀 Servidor corriendo en http://localhost:3001'
  );
});