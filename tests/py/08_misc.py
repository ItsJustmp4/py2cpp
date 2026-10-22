# комментарий
def avg(values):
    if not values:
        return 0.0
    return sum(values) / len(values)  # среднее

data = [1, 2, 3, 4]
print(avg(data))
total = 0
count = 0
for i, v in enumerate(data):
    total += v * i
    count += 1
print(total, count)
matrix_row = [0] * 5
matrix_row[2] = 9
print(matrix_row)
name = "Ivan"
if name.startswith("I") and len(name) > 3:
    print("ok", name[0], name[-1])
s = ""
for ch in name:
    s = ch + s
print(s)
x = y = 5
print(x + y)
print(abs(-3), abs(-2.5), max(3, 7), min(2.0, 9))
print(str(42) + "!", int("17") + 1)
